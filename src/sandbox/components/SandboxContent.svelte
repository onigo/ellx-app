<script>
  import { onMount, tick } from 'svelte';
  import Worksheet from './Worksheet.svelte';
  import NodeNavigator from './NodeNavigator.svelte';
  import HelpMenu from './HelpMenu.svelte';
  import ShortcutsHelper from './ShortcutsHelper.svelte';
  import { combination } from '../../utils/mod_keys.js';
  import { SET_ACTIVE_CONTENT } from '../mutations.js';

  import store, { contents, getSheet, nodeNavigatorOpen, shortcutsHelperOpen, contextMenuOpen } from '../store.js';
  import CalcGraph from '../../runtime/engine/calc_graph.js';
  import mountEllxApp from '../../runtime/mount_app.js';

  const Module = window.__ellx.Module;

  const htmlContentId = 'file:///src/index.html';

  const htmlCalcGraph = new CalcGraph(
    htmlContentId,
    url => Module.get(url),
    url => Module.require(url, htmlContentId)
  );

  Module.set(htmlContentId, htmlCalcGraph);

  setActiveContent(htmlContentId);

  let darkMode = false;

  $: activeContentId = $store.activeContentId;
  $: sheets = [...$contents.keys()];

  function setActiveContent(contentId) {
    store.commit(SET_ACTIVE_CONTENT, { contentId });
  }

  function escapeId(contentId) {
    return contentId.replace(/[^a-zA-Z0-9-_]+/g, '-');
  }

  let mountPoint;

  onMount(() => {
    mountEllxApp(mountPoint, htmlCalcGraph);
  });

  function kbListen(e) {
    const shortcut = combination(e);

    switch (shortcut) {
      case 'Alt+KeyD':
        e.preventDefault();
        toggleDark(darkMode = !darkMode);
        return;
      case 'Alt+Slash':
        e.preventDefault();
        shortcutsHelperOpen.update(value => !value);
        return;
      case 'Alt+Period':
        e.preventDefault();
        nodeNavigatorOpen.update(value => !value);
        return;
    }

    const digit = (/^Alt\+Digit([1-9])$/.exec(shortcut) || [])[1];
    if (!digit) return;

    e.preventDefault();

    if (digit === '1') {
      setActiveContent(htmlContentId);
    }
    else if (digit - 2 < sheets.length) {
      const contentId = sheets[digit - 2];
      setActiveContent(contentId);
      tick().then(() => focus(contentId));
    }
  }

  function goToLine({ detail }) {
    // notifyParent({
    //   line: detail,
    //   type: 'go-to-line',
    // })
  }

  function navigate({ detail }) {
    // detail === 'ellx|md|html'
    // can use to navigate to node definition in VS code extension

    // notifyParent({
    //   type: 'anchor',
    //   href: process.env.CLIENT_URL
    //     + '/'
    //     + $activeTab.replace(/\.[^.]*$/, '.' + detail)
    // });
  }

  function toggleDark(v) {
    if (v) {
      document.body.classList.add('dark');
    } else {
      document.body.classList.remove('dark');
    }
  }

  function focus(contentId) {
    const container = document.querySelector(`#sheet-${escapeId(contentId)} .grid__container`);
    if (container) container.focus();
  }

</script>

<svelte:window
  on:keydown={kbListen}
/>

<style>
  .sheet {
    position: absolute;
    width: 100%;
    height: 100%;
  }
</style>

{#each sheets as contentId (contentId)}
  <div class="sheet" id="sheet-{escapeId(contentId)}" class:hidden={contentId !== activeContentId}>
    <Worksheet store={getSheet(contentId)}/>
  </div>
{/each}

<div bind:this={mountPoint} class:hidden={htmlContentId !== activeContentId}>
</div>

<HelpMenu/>

<div class="fixed top-0 left-0 z-40 pointer-events-none w-full h-screen flex flex-col justify-end items-end"
  on:contextmenu={(e) => e.preventDefault()}
  on:mousedown={() => contextMenuOpen.set(false)}
>
  <NodeNavigator
    on:goToLine={goToLine}
    on:navigate={navigate}
  />
  <ShortcutsHelper/>
</div>
