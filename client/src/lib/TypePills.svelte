<script lang="ts">
  // Hierarchical type filter pills: multi-select (OR across types) + a buyable
  // (AND) toggle. Furniture drills down the catalog tree (Kitchen > Appliance > …);
  // clothing passes a flat single-level tree. Filter state lives in the parent —
  // this component is purely presentational, owning only the drill-down path.
  import type { TypeNode } from './gifts';

  interface Props {
    tree: TypeNode[];
    selected: string[];
    buyable: boolean;
    onToggleType: (path: string) => void;
    onToggleBuyable: () => void;
    onClear: () => void;
  }

  let { tree, selected, buyable, onToggleType, onToggleBuyable, onClear }: Props = $props();

  // Current drill location (array of path segments). Falls back to root if the
  // path no longer exists in a new tree (e.g. villager changed).
  let path: string[] = $state([]);

  const nodeMap = $derived.by(() => {
    const m = new Map<string, TypeNode>();
    const walk = (nodes: TypeNode[]) => {
      for (const n of nodes) {
        m.set(n.path, n);
        walk(n.children);
      }
    };
    walk(tree);
    return m;
  });

  const effectivePath = $derived.by(() => {
    const out: string[] = [];
    for (const seg of path) {
      if (!nodeMap.get([...out, seg].join('/'))) break;
      out.push(seg);
    }
    return out;
  });

  const level = $derived.by(() => {
    if (effectivePath.length === 0) return tree;
    return nodeMap.get(effectivePath.join('/'))!.children;
  });

  const anyFilter = $derived(selected.length > 0 || buyable);
  const drill = (node: TypeNode) => {
    path = [...effectivePath, node.label];
  };
</script>

<div class="type-pills border-t border-green-100 px-4 py-2">
  {#if effectivePath.length > 0}
    <div class="pill-crumbs mb-1.5 flex flex-wrap items-center gap-1 text-xs text-green-600">
      <button
        class="rounded px-1 py-0.5 hover:bg-green-100"
        onclick={() => (path = [])}
      >
        All
      </button>
      {#each effectivePath as seg, i}
        <span class="text-green-300">›</span>
        <button
          class="rounded px-1 py-0.5 font-medium text-green-800 hover:bg-green-100"
          onclick={() => (path = effectivePath.slice(0, i + 1))}
        >
          {seg}
        </button>
      {/each}
    </div>
  {/if}

  <div class="flex flex-wrap items-center gap-1.5">
    {#each level as node}
      <div
        class="inline-flex items-center overflow-hidden rounded-full text-xs {selected.includes(node.path)
          ? 'bg-green-700 text-white'
          : 'bg-green-100 text-green-800'}"
      >
        <button
          class="pill-main px-2.5 py-1"
          aria-pressed={selected.includes(node.path)}
          onclick={() => onToggleType(node.path)}
        >
          {node.label} <span class="opacity-70">{node.count}</span>
        </button>
        {#if node.children.length > 0}
          <button
            class="pill-drill self-stretch border-l px-1.5 hover:bg-black/10"
            aria-label="drill into {node.label}"
            onclick={() => drill(node)}
          >
            ›
          </button>
        {/if}
      </div>
    {/each}

    <button
      class="rounded-full px-2.5 py-1 text-xs {buyable
        ? 'bg-green-900 font-medium text-white'
        : 'bg-green-100 text-green-800'}"
      aria-pressed={buyable}
      onclick={onToggleBuyable}
    >
      Buyable only
    </button>

    {#if anyFilter}
      <button
        class="rounded-full px-2.5 py-1 text-xs text-green-500 underline hover:text-green-700"
        onclick={onClear}
      >
        Clear
      </button>
    {/if}
  </div>
</div>
