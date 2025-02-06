import { exec as e } from "child_process";
import chokidar from "chokidar";
import { all } from "conclure/combinators";
import { cps } from "conclure/effects";
import fs from "fs";
import { mkdir, readFile, readdir } from "fs/promises";
import md5 from "md5";
import { dirname, join } from "path";
import SftpClient from "ssh2-sftp-client";
import { default as t } from "tar";
import { fileURLToPath, pathToFileURL } from "url";
import { promisify } from "util";
import reactiveBuild from "./bundler/reactive_build.js";
import { resolveIndex } from "./resolve_index.js";
import { loadBody as parseEllx } from "./sandbox/body_parse.js";

const exec = promisify(e);
const tar = promisify(t.create);

const staticConfigIsValid = (staticConfig) => {
  const requiredKeys = [
    "remotePath",
    "remoteServer",
    "remoteUser",
    "remotePort",
  ];

  for (const key of requiredKeys) {
    if (!staticConfig || !(key in staticConfig) || !staticConfig[key]) {
      throw new Error(
        `Missing or falsy value for key '${key}' in static configuration`
      );
    }
  }
  return true;
};

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

export function* deploy(rootDir, { env, styles, local }) {
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

  console.log("Generating index.html...");
  const indexHtml = (yield resolveIndex(publicDir, rootDir))
    .replace(`<script type="module" src="/sandbox.js"></script>`, injection)
    .replace("/sandbox.css", cssSrc);

  toDeploy.set("/index.html", indexHtml);

  console.log("Getting deployment config...");

  const deployConfig = JSON.parse(fs.readFileSync("deploy.json", "utf8"));

  if (!deployConfig[env] && !local) {
    throw new Error(`No deployment configuration for environment ${env}`);
  }

  const staticConfig = deployConfig[env]["static"];

  if (staticConfig && staticConfigIsValid(staticConfig)) {
    try {
      deployToOnigoServer(toDeploy, staticConfig, local);
    } catch (error) {
      console.error(`Onigo deployment failed: ${error.message}`);
    }
  }
}

const deployToOnigoServer = async (
  toDeploy,
  {
    remoteServer,
    remoteUser,
    remotePort,
    remotePath,
    outFilename = "./out.tar.gz",
  },
  local
) => {
  // Should this throw instead?
  if (!process.env.SSH_KEY) {
    console.error("SSH key is not set");
    return;
  }

  const BUILD_PATH= "./dist";

  const privateKey = process.env.SSH_KEY.replace(/\\n/g, "\n");
  const config = {
    host: remoteServer,
    username: remoteUser,
    port: remotePort,
    privateKey: privateKey,
  };

  for (const [localPath, content] of toDeploy) {
    const tmpPath = join(BUILD_PATH, localPath);
    const tmpDir = dirname(tmpPath);
    await mkdir(tmpDir, { recursive: true });
    fs.writeFileSync(tmpPath, content);
  }

  if (local) {
    return;
  }

  console.log(`Attempting to deploy ${toDeploy.size} files to Onigo server...`);

  await tar(
    {
      gzip: true,
      file: outFilename,
    },
    [BUILD_PATH]
  );

  const client = new SftpClient();
  await client.connect(config);
  await client.put(outFilename, join(remotePath, outFilename));
  await client.end();

  console.log("Uploaded successfully.");

  console.log("Deployment to Onigo server complete");
};
