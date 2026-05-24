export interface FrameTreeNode {
  frame: { id: string; url?: string };
  childFrames?: FrameTreeNode[];
}

export interface AxProperty {
  name?: string;
  value?: { value?: unknown };
}

export interface AxNode {
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  description?: { value?: string };
  backendDOMNodeId?: number;
  properties?: AxProperty[];
  _frameUrl?: string;
  _frameId?: string;
}

export interface RefEntry {
  backendNodeId: number;
  frameId: string;
}

export interface ConsoleErrorEntry {
  level: string;
  message: string;
  time: number;
}

export interface FormatAxSnapshotInput {
  title: string;
  url: string;
  nodes: AxNode[];
  interactiveRoles: ReadonlySet<string>;
  recentErrors?: ConsoleErrorEntry[];
}

export interface FormatAxSnapshotResult {
  text: string;
  refMap: Map<string, RefEntry>;
  refLabels: Map<string, string>;
  diagnostics: {
    totalNodes: number;
    ignoredNodes: number;
    interactiveWithBackendId: number;
    interactiveWithoutBackendId: number;
    refCount: number;
    frameCount: number;
    topRoles: string;
  };
}

export function formatAxSnapshot(input: FormatAxSnapshotInput): FormatAxSnapshotResult {
  const { title, url, nodes, interactiveRoles, recentErrors = [] } = input;
  const lines: string[] = [];
  let refCounter = 0;
  const refMap = new Map<string, RefEntry>();
  const refLabels = new Map<string, string>();
  const frameIds = new Set<string>();
  let currentFrameUrl = '';

  lines.push(`Page: ${title}`);
  lines.push(`URL: ${url}`);
  lines.push('');

  let totalNodes = 0;
  let ignoredNodes = 0;
  let interactiveWithBackendId = 0;
  let interactiveWithoutBackendId = 0;
  const roleCounts = new Map<string, number>();

  for (const node of nodes) {
    totalNodes++;
    if (node.ignored) {
      ignoredNodes++;
      continue;
    }

    const role = node.role?.value || '';
    const name = (node.name?.value || '').trim();
    const value = (node.value?.value || '').trim();
    const backendId = node.backendDOMNodeId;
    const nodeFrameUrl = node._frameUrl || '';
    if (node._frameId) frameIds.add(node._frameId);

    if (role) roleCounts.set(role, (roleCounts.get(role) || 0) + 1);

    if (nodeFrameUrl && nodeFrameUrl !== currentFrameUrl && nodeFrameUrl !== 'about:blank') {
      currentFrameUrl = nodeFrameUrl;
      if (frameIds.size > 1) {
        const host = (() => {
          try {
            return new URL(nodeFrameUrl).hostname;
          } catch {
            return nodeFrameUrl.slice(0, 50);
          }
        })();
        lines.push(`\n--- frame: ${host} ---`);
      }
    }

    const props = node.properties ?? [];
    const isDisabled = props.some(p => p.name === 'disabled' && p.value?.value === true);
    const isEditable = props.some(p => p.name === 'editable' && p.value?.value);
    const isFocused = props.some(p => p.name === 'focused' && p.value?.value === true);
    const description = (node.description?.value || '').trim();

    if (interactiveRoles.has(role) || isEditable) {
      if (backendId) {
        interactiveWithBackendId++;
        refCounter++;
        const ref = `e${refCounter}`;
        refMap.set(ref, { backendNodeId: backendId, frameId: node._frameId || '' });
        const displayName = name || role;
        refLabels.set(ref, displayName);

        const disabledTag = isDisabled ? ' [DISABLED]' : '';
        const focusedTag = isFocused ? ' [FOCUSED]' : '';
        const valueDisplay = value ? ` value="${value.slice(0, 40)}"` : '';
        const descDisplay = description && description !== name ? ` (desc: "${description.slice(0, 40)}")` : '';
        lines.push(`[${ref}] ${role} "${displayName.slice(0, 60)}"${valueDisplay}${descDisplay}${disabledTag}${focusedTag}`);
      } else {
        interactiveWithoutBackendId++;
      }
    } else if (role === 'heading' && name) {
      lines.push(`heading: ${name.slice(0, 80)}`);
    } else if (role === 'staticText' && name.length > 1) {
      lines.push(`text: ${name.slice(0, 120)}`);
    } else if (role === 'image' && name && backendId) {
      refCounter++;
      const ref = `e${refCounter}`;
      refMap.set(ref, { backendNodeId: backendId, frameId: node._frameId || '' });
      refLabels.set(ref, name);
      lines.push(`[${ref}] img "${name.slice(0, 60)}"`);
    }
  }

  const topRoles = [...roleCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([r, c]) => `${r}:${c}`)
    .join(', ');

  if (frameIds.size > 1) {
    lines.push(`\n📌 Content spans ${frameIds.size} frames (cross-origin included — all refs work directly, no need to switch frames).`);
  }

  const recent = recentErrors.filter(e => Date.now() - e.time < 30_000);
  if (recent.length > 0) {
    lines.push('\n⚠️ Recent page errors:');
    for (const err of recent.slice(-5)) {
      lines.push(`  [${err.level}] ${err.message}`);
    }
  }

  let text: string;
  if (lines.length <= 500) {
    text = lines.join('\n');
  } else {
    const first400 = lines.slice(0, 400);
    const first400Set = new Set(first400);
    const missedRefs = lines.slice(400).filter(l => l.startsWith('[e') && !first400Set.has(l));
    if (missedRefs.length > 0) {
      first400.push(`\n… (${lines.length - 400} lines truncated, ${missedRefs.length} refs appended below)`);
      first400.push(...missedRefs);
    }
    text = first400.join('\n');
  }

  return {
    text,
    refMap,
    refLabels,
    diagnostics: {
      totalNodes,
      ignoredNodes,
      interactiveWithBackendId,
      interactiveWithoutBackendId,
      refCount: refCounter,
      frameCount: frameIds.size,
      topRoles,
    },
  };
}
