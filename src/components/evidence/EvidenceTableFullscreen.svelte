<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import ComponentTitle from '@evidence/core/user-components/common/ComponentTitle.svelte';

  // Core's body portal leaves the shadow root (and its styles). A native modal
  // stays in the report's themed DOM while the top layer escapes scroll clipping.
  let { open, onClose, title, subtitle, info, info_link, info_link_title, children }: {
    open: boolean;
    onClose: () => void;
    title?: string;
    subtitle?: string;
    info?: string;
    info_link?: string;
    info_link_title?: string;
    children: Snippet;
  } = $props();
  let dialog: HTMLDialogElement;
  onMount(() => {
    if (open) dialog.showModal();
    return () => { dialog.close(); };
  });
</script>

<dialog bind:this={dialog} aria-label={title ?? 'Table'} onclose={onClose}
  onkeydown={(event) => { if (event.key === 'Escape') event.stopPropagation(); }}
  oncancel={(event) => { event.preventDefault(); event.stopPropagation(); dialog.close(); }}>
  <button class="close" aria-label="Close expanded table" onclick={() => dialog.close()}>×</button>
  <div class="heading">
    {#if title || subtitle}
      <ComponentTitle {title} {subtitle} {info} {info_link} {info_link_title} />
    {/if}
  </div>
  <div class="table-body">{@render children()}</div>
</dialog>

<style>
  dialog {
    position: fixed;
    inset: 0;
    margin: auto;
    width: calc(100vw - 3rem);
    max-width: none;
    max-height: calc(100dvh - 3rem);
    padding: 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius, .5rem);
    background: var(--background);
    color: var(--foreground);
    box-shadow: 0 20px 60px #0004;
    overflow: hidden;
  }
  dialog[open] { display: flex; flex-direction: column; }
  dialog::backdrop { background: #0008; }
  .heading { min-height: 2rem; padding-right: 2rem; flex-shrink: 0; }
  .table-body { min-height: 0; overflow: auto; }
  .close {
    position: absolute; top: .5rem; right: .5rem;
    width: 2rem; height: 2rem; border-radius: .25rem;
    font-size: 1.5rem; line-height: 1; cursor: pointer;
  }
  .close:hover { background: var(--muted); }
  .close:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  @media (max-width: 640px) {
    dialog { width: calc(100vw - 1rem); max-height: calc(100dvh - 1rem); padding: .75rem; }
  }
</style>
