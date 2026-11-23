// Deterministic, zero-JS, zero-inline-style SVG diagram renderers for Canon v2.
// Every <svg> carries aria-hidden="true" and pairs with semantic HTML text inside the
// enclosing <figure> so screen readers, print/PDF, and Markdown parity stay complete.
import { escapeAttr, escapeHtml } from './escape.mjs';
import { clampSvgPx, estSvgPx } from './svg-chart.mjs';

function wrapSvgPx(text, maxWidthPx, maxLines = 2, fontSize = 12, opts = {}) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let restWords = [...words];

  while (restWords.length > 0 && lines.length < maxLines) {
    const isLastLine = lines.length === maxLines - 1;
    let current = restWords.shift();
    if (estSvgPx(current, fontSize, opts) > maxWidthPx) {
      if (isLastLine) {
        lines.push(clampSvgPx([current, ...restWords].join(' '), maxWidthPx, fontSize, opts));
        return lines;
      }
      const chars = [...current];
      let cut = 1;
      while (cut < chars.length && estSvgPx(chars.slice(0, cut + 1).join(''), fontSize, opts) <= maxWidthPx) {
        cut += 1;
      }
      lines.push(chars.slice(0, cut).join(''));
      restWords.unshift(chars.slice(cut).join(''));
      continue;
    }
    while (restWords.length > 0) {
      const candidate = `${current} ${restWords[0]}`;
      if (estSvgPx(candidate, fontSize, opts) <= maxWidthPx) {
        current = candidate;
        restWords.shift();
      } else {
        break;
      }
    }
    if (isLastLine && restWords.length > 0) {
      lines.push(clampSvgPx(`${current} ${restWords.join(' ')}`, maxWidthPx, fontSize, opts));
      return lines;
    }
    lines.push(current);
  }
  return lines;
}

function arrowHeadPoints(tipX, tipY, angleRad, size = 7) {
  const spread = Math.PI / 6.2;
  const x1 = tipX - size * Math.cos(angleRad - spread);
  const y1 = tipY - size * Math.sin(angleRad - spread);
  const x2 = tipX - size * Math.cos(angleRad + spread);
  const y2 = tipY - size * Math.sin(angleRad + spread);
  const fmt = (n) => Number(n.toFixed(1));
  return `${fmt(tipX)},${fmt(tipY)} ${fmt(x1)},${fmt(y1)} ${fmt(x2)},${fmt(y2)}`;
}

export function renderFlowDiagram(block) {
  const steps = block.steps;
  const cols = steps.length <= 5 ? steps.length : Math.ceil(steps.length / Math.ceil(steps.length / 4));
  const rows = Math.ceil(steps.length / cols);
  const nodeW = cols === 5 ? 164 : 192;
  const nodeH = 68;
  const gapX = cols === 5 ? 30 : 38;
  const gapY = 34;
  const padX = 18;
  const padY = 18;
  const width = padX * 2 + cols * nodeW + (cols - 1) * gapX;
  const height = padY * 2 + rows * nodeH + (rows - 1) * gapY;

  const coords = steps.map((_, idx) => {
    const row = Math.floor(idx / cols);
    const colInRow = idx % cols;
    // Snake layout on multi-row flows so arrows connect naturally without crossing full width
    const col = row % 2 === 0 ? colInRow : cols - 1 - colInRow;
    return {
      x: padX + col * (nodeW + gapX),
      y: padY + row * (nodeH + gapY),
      row,
      col,
    };
  });

  const connectors = [];
  for (let i = 0; i < steps.length - 1; i += 1) {
    const a = coords[i];
    const b = coords[i + 1];
    const isGate = Boolean(steps[i + 1].gate);
    const strokeCls = isGate ? 'svg-edge svg-edge--gate' : 'svg-edge';
    const arrowCls = isGate ? 'svg-arrow svg-arrow--gate' : 'svg-arrow';
    if (a.row === b.row) {
      const forward = b.x > a.x;
      const x1 = forward ? a.x + nodeW : a.x;
      const x2 = forward ? b.x - 2 : b.x + nodeW + 2;
      const y = a.y + nodeH / 2;
      connectors.push(
        `<line class="${strokeCls}" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" />`,
        `<polygon class="${arrowCls}" points="${arrowHeadPoints(forward ? b.x : b.x + nodeW, y, forward ? 0 : Math.PI)}" />`,
      );
    } else {
      const cx = a.x + nodeW / 2;
      const y1 = a.y + nodeH;
      const y2 = b.y - 2;
      connectors.push(
        `<line class="${strokeCls}" x1="${cx}" y1="${y1}" x2="${cx}" y2="${y2}" />`,
        `<polygon class="${arrowCls}" points="${arrowHeadPoints(cx, b.y, Math.PI / 2)}" />`,
      );
    }
  }

  const nodes = steps.map((step, idx) => {
    const { x, y } = coords[idx];
    const isGate = Boolean(step.gate);
    const lines = wrapSvgPx(step.label, nodeW - 24, 2, 12);
    const cls = isGate ? 'svg-node svg-node--gate' : 'svg-node';
    const badgeW = isGate ? 58 : 28;
    const badgeText = isGate ? `${String(idx + 1).padStart(2, '0')} GATE` : String(idx + 1).padStart(2, '0');
    const textStartY = lines.length === 1 ? y + 46 : y + 39;
    return `<g class="${cls}">
  <rect class="svg-node__box" x="${x}" y="${y}" width="${nodeW}" height="${nodeH}" rx="7" />
  <rect class="svg-node__accent" x="${x}" y="${y}" width="${nodeW}" height="4" rx="2" />
  <rect class="svg-node__pill" x="${x + 10}" y="${y + 10}" width="${badgeW}" height="16" rx="4" />
  <text class="svg-node__num" x="${x + 10 + badgeW / 2}" y="${y + 21}" text-anchor="middle">${escapeHtml(badgeText)}</text>
  ${lines.map((ln, li) => `<text class="svg-node__title" x="${x + 12}" y="${textStartY + li * 15}">${escapeHtml(ln)}</text>`).join('\n  ')}
</g>`;
  });

  const svg = `<div class="diagram-canvas">
<svg class="svg-graphic svg-graphic--flow" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false">
${connectors.join('\n')}
${nodes.join('\n')}
</svg>
</div>`;

  const ledger = `<ol class="flow-ledger">
${steps.map((step, i) => `<li class="flow-ledger__item${step.gate ? ' flow-ledger__item--gate' : ''}">
  <div class="flow-ledger__head"><span class="flow__num" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span> <strong>${escapeHtml(step.label)}</strong>${step.gate ? ' <span class="badge badge--gate">Gate</span>' : ''}</div>
  <p>${escapeHtml(step.detail)}</p>
</li>`).join('\n')}
</ol>`;

  return `${svg}\n${ledger}`;
}

export function renderTopologyDiagram(block) {
  const groups = block.groups;
  const maxNodesInGroup = Math.max(...groups.map((g) => g.nodes.length));
  const nodeW = 198;
  const nodeH = 62;
  const gapX = 56;
  const groupPadX = 24;
  const groupTopPad = 46;
  const groupBottomPad = 18;
  const groupGapY = 62;
  const outerPad = 18;

  const innerMaxW = maxNodesInGroup * nodeW + Math.max(0, maxNodesInGroup - 1) * gapX;
  const groupW = Math.max(520, innerMaxW + groupPadX * 2);
  const groupH = groupTopPad + nodeH + groupBottomPad;
  const width = outerPad * 2 + groupW;
  const height = outerPad * 2 + groups.length * groupH + (groups.length - 1) * groupGapY;

  const nodePos = new Map();
  const nodeLabels = new Map();
  const groupSvg = [];

  groups.forEach((group, gi) => {
    const gx = outerPad;
    const gy = outerPad + gi * (groupH + groupGapY);
    const groupTitle = clampSvgPx(group.label, groupW - 28, 11);
    groupSvg.push(
      `<g class="svg-group">
  <rect class="svg-group__frame" x="${gx}" y="${gy}" width="${groupW}" height="${groupH}" rx="8" />
  <text class="svg-group__label" x="${gx + 14}" y="${gy + 20}">${escapeHtml(groupTitle)}</text>
</g>`,
    );

    const rowW = group.nodes.length * nodeW + Math.max(0, group.nodes.length - 1) * gapX;
    const startX = gx + (groupW - rowW) / 2;
    const ny = gy + groupTopPad;

    group.nodes.forEach((node, ni) => {
      const nx = startX + ni * (nodeW + gapX);
      const role = node.role ?? 'core';
      nodePos.set(node.id, { x: nx, y: ny, w: nodeW, h: nodeH, gi, ni, gy });
      nodeLabels.set(node.id, node.label);
      const titleLine = clampSvgPx(node.label, nodeW - 26, 12);
      const subLine = node.sublabel ? clampSvgPx(node.sublabel, nodeW - 26, 10, { mono: true }) : '';
      groupSvg.push(
        `<g class="svg-node svg-node--role-${escapeAttr(role)}">
  <rect class="svg-node__box" x="${nx}" y="${ny}" width="${nodeW}" height="${nodeH}" rx="6" />
  <rect class="svg-node__accent" x="${nx}" y="${ny}" width="5" height="${nodeH}" rx="2" />
  <text class="svg-node__title" x="${nx + 14}" y="${ny + (subLine ? 26 : 35)}">${escapeHtml(titleLine)}</text>
  ${subLine ? `<text class="svg-node__sub" x="${nx + 14}" y="${ny + 45}">${escapeHtml(subLine)}</text>` : ''}
</g>`,
      );
    });
  });

  const placedPills = [];
  const edgePathsSvg = [];
  const edgePillsSvg = [];

  block.edges.forEach((edge) => {
    const a = nodePos.get(edge.from);
    const b = nodePos.get(edge.to);
    const style = edge.style ?? 'solid';
    const isGate = style === 'gate';
    const edgeCls = `svg-edge svg-edge--${escapeAttr(style)}`;
    const arrowCls = isGate ? 'svg-arrow svg-arrow--gate' : 'svg-arrow';

    let pathD;
    let tipX;
    let tipY;
    let angle;
    let labelX;
    let labelY;

    if (a.gi === b.gi) {
      const forward = b.x >= a.x;
      const x1 = forward ? a.x + a.w : a.x;
      const x2 = forward ? b.x - 2 : b.x + b.w + 2;
      const y = a.y + a.h / 2;
      pathD = `M ${x1} ${y} L ${x2} ${y}`;
      tipX = forward ? b.x : b.x + b.w;
      tipY = y;
      angle = forward ? 0 : Math.PI;
      labelX = (x1 + tipX) / 2;
      // Place horizontal same-tier edge labels in the clear top band above the inter-node gap
      labelY = a.y - 6;
    } else {
      const down = b.y > a.y;
      const x1 = a.x + a.w / 2;
      const y1 = down ? a.y + a.h : a.y;
      const x2 = b.x + b.w / 2;
      const y2 = down ? b.y - 3 : b.y + b.h + 3;
      const channelMidY = down
        ? a.gy + groupH + groupGapY / 2
        : a.gy - groupGapY / 2;
      pathD = `M ${x1} ${y1} C ${x1} ${channelMidY}, ${x2} ${channelMidY}, ${x2} ${y2}`;
      tipX = x2;
      tipY = down ? b.y : b.y + b.h;
      angle = down ? Math.PI / 2 : -Math.PI / 2;
      // Evaluate cubic Bezier at t=0.5 so the pill sits cleanly on the curve inside the inter-tier gap
      labelX = 0.125 * x1 + 0.375 * x1 + 0.375 * x2 + 0.125 * x2;
      labelY = 0.125 * y1 + 0.75 * channelMidY + 0.125 * y2 + 3;
    }

    edgePathsSvg.push(`<g class="svg-edge-group">
  <path class="${edgeCls}" d="${pathD}" fill="none" />
  <polygon class="${arrowCls}" points="${arrowHeadPoints(tipX, tipY, angle)}" />
</g>`);

    if (edge.label) {
      const text = clampSvgPx(edge.label, 155, 10, { mono: true });
      const pw = Math.max(48, estSvgPx(text, 10, { mono: true }) + 16);
      const clampedLabelX = Math.max(pw / 2 + 8, Math.min(width - pw / 2 - 8, labelX));
      let py = labelY;
      while (placedPills.some((prev) => Math.abs(prev.y - py) < 17 && Math.abs(prev.x - clampedLabelX) < (prev.w + pw) / 2 + 6)) {
        py += 18;
      }
      placedPills.push({ x: clampedLabelX, y: py, w: pw });
      edgePillsSvg.push(`<g class="svg-edge-label-group">
  <rect class="svg-edge-pill${isGate ? ' svg-edge-pill--gate' : ''}" x="${(clampedLabelX - pw / 2).toFixed(1)}" y="${(py - 11).toFixed(1)}" width="${pw.toFixed(1)}" height="16" rx="4" />
  <text class="svg-edge-label" x="${clampedLabelX.toFixed(1)}" y="${py.toFixed(1)}" text-anchor="middle">${escapeHtml(text)}</text>
</g>`);
    }
  });

  const svg = `<div class="diagram-canvas">
<svg class="svg-graphic svg-graphic--topology" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false">
${groupSvg.join('\n')}
${edgePathsSvg.join('\n')}
${edgePillsSvg.join('\n')}
</svg>
</div>`;

  const groupsHtml = `<div class="topo-ledger">
  <div class="topo-ledger__groups">
    ${groups.map((g) => `<div class="topo-group-card">
      <p class="field-label">${escapeHtml(g.label)}</p>
      <ul>${g.nodes.map((n) => `<li><strong>${escapeHtml(n.label)}</strong>${n.sublabel ? ` <span class="muted">— ${escapeHtml(n.sublabel)}</span>` : ''}</li>`).join('')}</ul>
    </div>`).join('\n    ')}
  </div>
  <ol class="topo-ledger__edges">
    ${block.edges.map((e) => `<li><code>${escapeHtml(nodeLabels.get(e.from) ?? e.from)}</code> → <code>${escapeHtml(nodeLabels.get(e.to) ?? e.to)}</code>${e.label ? ` — <span>${escapeHtml(e.label)}</span>` : ''}${e.style === 'gate' ? ' <span class="badge badge--gate">Gate</span>' : ''}</li>`).join('\n    ')}
  </ol>
</div>`;

  return `${svg}\n${groupsHtml}`;
}

export function renderSequenceDiagram(block) {
  const actors = block.actors;
  const messages = block.messages;
  const actorW = 140;
  const actorH = 42;
  const colSpan = 178;
  const padX = 24;
  const padY = 16;
  const hasNotes = messages.some((m) => m.note);
  const rightMostActorRight = padX + (actors.length - 1) * colSpan + actorW;
  const noteLaneX = rightMostActorRight + 22;
  const noteBoxW = 196;
  const rowH = 50;
  const topLifelineY = padY + actorH;
  const firstMsgY = topLifelineY + 34;
  const bottomY = firstMsgY + messages.length * rowH + 10;
  const width = hasNotes ? noteLaneX + noteBoxW + padX : rightMostActorRight + 80;
  const height = bottomY + 18;

  const actorX = new Map();
  const actorLabel = new Map();
  const actorSvg = actors.map((actor, idx) => {
    const cx = padX + actorW / 2 + idx * colSpan;
    actorX.set(actor.id, cx);
    actorLabel.set(actor.id, actor.label);
    const x = cx - actorW / 2;
    const kind = actor.kind ?? 'service';
    const actorTitle = clampSvgPx(actor.label, actorW - 20, 12);
    return `<g class="svg-actor svg-actor--${escapeAttr(kind)}">
  <line class="svg-lifeline" x1="${cx}" y1="${topLifelineY}" x2="${cx}" y2="${bottomY}" />
  <rect class="svg-node__box" x="${x}" y="${padY}" width="${actorW}" height="${actorH}" rx="6" />
  <rect class="svg-node__accent" x="${x}" y="${padY}" width="${actorW}" height="4" rx="2" />
  <text class="svg-node__title" x="${cx}" y="${padY + 26}" text-anchor="middle">${escapeHtml(actorTitle)}</text>
</g>`;
  });

  const maxPillRight = hasNotes ? noteLaneX - 12 : width - padX;
  const msgSvg = messages.map((msg, idx) => {
    const y = firstMsgY + idx * rowH;
    const x1 = actorX.get(msg.from);
    const x2 = actorX.get(msg.to);
    const kind = msg.kind ?? 'sync';
    const isGate = Boolean(msg.gate);
    const edgeCls = isGate ? 'svg-edge svg-edge--gate' : kind === 'reply' ? 'svg-edge svg-edge--dashed' : 'svg-edge';
    const arrowCls = isGate ? 'svg-arrow svg-arrow--gate' : 'svg-arrow';

    let lineEl;
    let rawCenterX;
    if (x1 === x2) {
      const loopW = 34;
      lineEl = `<path class="${edgeCls}" d="M ${x1} ${y - 2} L ${x1 + loopW} ${y - 2} L ${x1 + loopW} ${y + 12} L ${x1 + 3} ${y + 12}" fill="none" />
  <polygon class="${arrowCls}" points="${arrowHeadPoints(x1, y + 12, Math.PI)}" />`;
      rawCenterX = x1 + loopW / 2;
    } else {
      const forward = x2 > x1;
      const targetX = forward ? x2 - 3 : x2 + 3;
      lineEl = `<line class="${edgeCls}" x1="${x1}" y1="${y}" x2="${targetX}" y2="${y}" />
  <polygon class="${arrowCls}" points="${arrowHeadPoints(x2, y, forward ? 0 : Math.PI)}" />`;
      rawCenterX = (x1 + x2) / 2;
    }

    const maxPillTextPx = Math.min(230, maxPillRight - padX - 20);
    const labelStr = clampSvgPx(`${idx + 1}. ${msg.label}`, maxPillTextPx, 10, { mono: true });
    const pillW = Math.max(58, Math.min(maxPillRight - padX, estSvgPx(labelStr, 10, { mono: true }) + 16));
    const pillX = Math.max(padX, Math.min(rawCenterX - pillW / 2, maxPillRight - pillW));
    const pillCenterX = pillX + pillW / 2;

    const noteEl = msg.note
      ? (() => {
        const noteText = clampSvgPx(msg.note, noteBoxW - 18, 10);
        return `<rect class="svg-note-box" x="${noteLaneX}" y="${y - 11}" width="${noteBoxW}" height="22" rx="4" />
  <text class="svg-note-text" x="${noteLaneX + 9}" y="${y + 4}">${escapeHtml(noteText)}</text>`;
      })()
      : '';

    return `<g class="svg-msg">
  <circle class="svg-msg__origin" cx="${x1}" cy="${x1 === x2 ? y - 2 : y}" r="3" />
  ${lineEl}
  <rect class="svg-edge-pill${isGate ? ' svg-edge-pill--gate' : ''}" x="${pillX.toFixed(1)}" y="${(y - 21).toFixed(1)}" width="${pillW.toFixed(1)}" height="16" rx="3" />
  <text class="svg-edge-label" x="${pillCenterX.toFixed(1)}" y="${(y - 9.5).toFixed(1)}" text-anchor="middle">${escapeHtml(labelStr)}</text>
  ${noteEl}
</g>`;
  });

  const svg = `<div class="diagram-canvas">
<svg class="svg-graphic svg-graphic--sequence" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false">
${actorSvg.join('\n')}
${msgSvg.join('\n')}
</svg>
</div>`;

  const ledger = `<ol class="seq-ledger">
${messages.map((m) => `<li><strong>${escapeHtml(actorLabel.get(m.from) ?? m.from)} → ${escapeHtml(actorLabel.get(m.to) ?? m.to)}</strong>: <code>${escapeHtml(m.label)}</code>${m.gate ? ' <span class="badge badge--gate">Gate</span>' : ''}${m.note ? ` <span class="muted">— ${escapeHtml(m.note)}</span>` : ''}</li>`).join('\n')}
</ol>`;

  return `${svg}\n${ledger}`;
}
