import aws from "aws-sdk";
import { exec } from "child_process";
import chokidar from "chokidar";
import { all } from "conclure/combinators";
import { cps } from "conclure/effects";
import fs from "fs";
import { readdir, readFile } from "fs/promises";
import md5 from "md5";
import { join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import reactiveBuild from "./bundler/reactive_build.js";
import { resolveIndex } from "./resolve_index.js";
import { loadBody as parseEllx } from "./sandbox/body_parse.js";
const execCommand = (cmd, cb) => {
  const child = exec(cmd, (err, stdout, stderr) => {
    console.log(stdout);
    console.error(stderr);
    cb(err);
  });
  return () => child.kill();
};

function* collectEntryPoints(dir) {
  const items = yield readdir(dir, { withFileTypes: true });

  const files = yield all(
    items.map(function* (item) {
      const fullname = join(dir, item.name);

      if (item.isDirectory()) {
        return collectEntryPoints(fullname);
      }

      if (item.isFile() && /\.(ellx|js)$/.test(item.name)) {
        return [fullname];
      }
    })
  );
  return files.filter(Boolean).flat();
}

function build(entryPoints, rootDir, cb) {
  const watcher = chokidar.watch(rootDir);
  let off;

  function cancel() {
    if (off) off();
    return watcher.close();
  }

  watcher.on("ready", () => {
    off = reactiveBuild(
      () => entryPoints,
      watcher,
      rootDir,
      (modules) =>
        cancel()
          .then(() => cb(null, modules))
          .catch((e) => cb(e))
    );
  });

  return cancel;
}

const MODULE_MANAGER =
  "file:///node_modules/@ellx/app/src/runtime/module_manager.js";
const RUNTIME = "file:///node_modules/@ellx/app/src/runtime/runtime.js";

function getContentType(path) {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".css")) return "text/css";
  return "application/javascript";
}

export function* deploy(rootDir, { env, styles }) {
  const files = (yield collectEntryPoints(`${rootDir}/src`))
    .map((path) => path.slice(rootDir.length))
    .map((path) => pathToFileURL(path).href)
    .concat([MODULE_MANAGER, RUNTIME]);

  // Load all sheets
  const sheets = Object.fromEntries(
    yield all(
      files
        .filter((id) => id.endsWith(".ellx"))
        .map(function* loadSheet(id) {
          const { nodes } = parseEllx(
            yield readFile(join(rootDir, fileURLToPath(id)), "utf8")
          );
          return [id, nodes];
        })
    )
  );

  // Make the bundle
  const jsFiles = files.filter((id) => id.endsWith(".js"));

  const modules = yield cps(build, jsFiles, rootDir);

  console.log(`Bundle ready. Generated ${Object.keys(modules).length} entries`);

  // Extract the files to deploy and calculate their hashes
  const toDeploy = new Map();

  const appendFile = (urlPath, code) => {
    const hash = md5(code);
    const hashedUrlPath = urlPath.replace(
      /\.[^.]*$/,
      (ext) => "-" + hash.slice(0, 8) + ext
    );

    toDeploy.set(hashedUrlPath, code);
    return hashedUrlPath;
  };

  for (let id in modules) {
    const node = modules[id];
    if (!node) {
      throw new Error(`${id} could not be resolved`);
    }

    const { code } = node;

    if (typeof code === "string") {
      delete node.code;
      node.src = appendFile(id.slice(7), code);
    }
  }

  const bootstrapSrc = appendFile(
    "/bootstrap.js",
    yield readFile(
      join(rootDir, "node_modules/@ellx/app/src/bootstrap/bootstrap.js"),
      "utf8"
    )
  );

  const modulesSrc = appendFile(
    "/modules.js",
    "export default " + JSON.stringify(modules)
  );
  const sheetsSrc = appendFile(
    "/sheets.js",
    "export default " + JSON.stringify(sheets)
  );

  // Prepare index.html body
  const injection = `<script type="module">
    import { bootstrapModule, asyncRetry, prefetch } from "${bootstrapSrc}";
    import modules from "${modulesSrc}";
    import sheets from "${sheetsSrc}";

    async function run() {
      const Module = await bootstrapModule(modules, "file:///node_modules/@ellx/app/src/runtime/module_manager.js", '${env}');
      const Runtime = await asyncRetry(Module.require)("${RUNTIME}");

      Runtime.initializeEllxApp(Module, sheets);
    }

    prefetch(Object.values(modules));

    run().catch(console.error);
  </script>`;

  const publicDir = join(rootDir, "node_modules/@ellx/app/src/bootstrap");

  // Styles
  const twConfig = join(rootDir, "tailwind.config.cjs");
  const twStylesIn = join(rootDir, styles);
  const twStylesOut = join(publicDir, "sandbox.css");

  console.log("Generating styles...");

  yield cps(
    execCommand,
    `npx tailwindcss -c ${twConfig} -i ${twStylesIn} -o ${twStylesOut}`
  );

  const cssSrc = appendFile("/styles.css", yield readFile(twStylesOut, "utf8"));

  const indexHtml = (yield resolveIndex(publicDir, rootDir))
    .replace(`<script type="module" src="/sandbox.js"></script>`, injection)
    .replace("/sandbox.css", cssSrc);

  toDeploy.set("/index.html", indexHtml);

  console.log(`Deploying ${toDeploy.size} files...`);
  console.log("Get deployment URLs...");

  const data = JSON.parse(fs.readFileSync("deploy.json", "utf8"));

  if (!data[env]) {
    throw new Error(`No deployment configuration for environment ${env}`);
  }

  const deployConfig = data[env];

  const s3 = new aws.S3({
    region: "ap-northeast-1",
  });
  const cf = new aws.CloudFront();
  let handles = [];
  for (let [path, content] of toDeploy) {
    console.log(
      "Uploading " + path,
      content.length,
      getContentType(path),
      deployConfig.s3
    );
    handles.push(
      s3
        .putObject({
          Bucket: deployConfig.s3,
          Key: path.slice(1),
          Body: content,
          ContentType: getContentType(path),
          ACL: "public-read",
          CacheControl:
            path === "/index.html" ? "max-age=60" : "max-age=31536000",
        })
        .promise()
    );
  }
  const ress = yield Promise.all(handles);

  const res = yield cf
    .createInvalidation({
      DistributionId: deployConfig.cloudfront,
      InvalidationBatch: {
        Paths: {
          Quantity: 1,
          Items: ["/index.html"],
        },
        CallerReference: Date.now() + deployConfig.cloudfront,
      },
    })
    .promise();

  console.log("Deployment complete", deployConfig.url, ress, res);
}
