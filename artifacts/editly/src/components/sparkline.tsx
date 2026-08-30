/**
 * Fourteen days of a number, drawn small enough to sit inside a card.
 *
 * Not a chart. A chart has axes and a legend and asks to be read; this is a
 * shape you take in at a glance beside the figure it belongs to, which is the
 * only thing that fits in the space a card has and the only thing anybody
 * wants from it there.
 *
 * Three decisions worth writing down:
 *
 * **The baseline is zero, not the minimum.** A series that runs 40, 41, 42
 * scaled to its own range is a cliff; scaled from zero it is the flat line it
 * actually is. Auto-scaling to the data is how a sparkline lies.
 *
 * **The last point is marked.** The eye needs somewhere to land, and where the
 * series *ended* is the thing the number beside it is showing.
 *
 * **It is `aria-hidden`.** The figure and the change are already written out in
 * text next to it; a screen reader announcing fourteen numbers is noise, and
 * announcing "chart" is worse — it promises something that is not there.
 */

export function Sparkline({
  values,
  className = "",
  width = 96,
  height = 28,
}: {
  values: number[];
  className?: string;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return null;

  // From zero, always. See above.
  const top = Math.max(1, ...values);
  const stepX = width / (values.length - 1);
  // 1px of padding top and bottom so the stroke and the endpoint dot are not
  // clipped by the viewBox at the extremes.
  const y = (v: number) => height - 1 - (v / top) * (height - 2);

  const points = values.map((v, i) => [i * stepX, y(v)] as const);
  const line = points.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
  // The fill closes the path along the bottom edge, which is what makes a
  // thirty-pixel line read as a quantity rather than as a squiggle.
  const area = `${line} L${width},${height} L0,${height} Z`;
  const [lastX, lastY] = points[points.length - 1];

  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d={area} fill="currentColor" opacity="0.13" />
      <path
        d={line}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.85"
      />
      <circle cx={lastX} cy={lastY} r="2.2" fill="currentColor" />
    </svg>
  );
}

/**
 * This week against the one before it, as a sentence.
 *
 * Returns null when there is nothing honest to say: a week that started from
 * zero has no percentage — "up 100%" from one signup to two is arithmetic, not
 * information, and a console that says it teaches you to ignore the ones that
 * mean something.
 */
export function weekOnWeek(thisWeek: number, lastWeek: number): {
  text: string;
  direction: "up" | "down" | "flat";
} | null {
  if (lastWeek === 0) {
    if (thisWeek === 0) return null;
    return { text: `${thisWeek} this week, none last`, direction: "up" };
  }
  const change = Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
  if (change === 0) return { text: "level with last week", direction: "flat" };
  return {
    text: `${change > 0 ? "up" : "down"} ${Math.abs(change)}% on last week`,
    direction: change > 0 ? "up" : "down",
  };
}
