import { useState } from "react";

/**
 * A fortnight of the platform, drawn big enough to read.
 *
 * The console already had sparklines, and a sparkline is deliberately not a
 * chart: no axis, no legend, no way to compare one series against another. It
 * is the right thing inside a card and it cannot answer the question an
 * operator actually opens the console with on a quiet morning, which is not
 * "how many today" but "is this week like last week".
 *
 * Hand-drawn rather than pulled from a library, and that is a budget decision
 * with a number behind it. The whole reason this screen is lazily loaded is
 * that the entry chunk was 772kB and `tools/speed-test.mjs` now holds it under
 * 200kB gzipped; a charting library is between 40kB and 120kB of that, for one
 * screen that one account opens. Fourteen points and four series is a
 * polyline.
 *
 * Four decisions worth writing down:
 *
 * **One series is drawn at a time.** Renders, minutes, failures and signups
 * have nothing in common but a date: forty minutes and two failures on one
 * axis makes the failures a flat line at the bottom, which is exactly the
 * series somebody is looking for. The legend switches rather than overlays,
 * and each chip carries its own fortnight total so the numbers are all
 * readable at once even though the shapes are not.
 *
 * **The baseline is zero.** A series that runs 40, 41, 42 scaled to its own
 * range is a cliff. Auto-scaling to the data is the most common way a chart
 * lies, and it lies in the alarming direction.
 *
 * **It is drawn left to right in both languages.** The product mirrors, and
 * time does not: an Arabic reader reading a fortnight still expects the oldest
 * day at the start of the line and the newest at the end, and mirroring the
 * plot would put "today" where the axis begins. The labels around it are laid
 * out by the page and follow the language; the plot is `dir="ltr"` on purpose.
 *
 * **The hover readout is the whole interaction.** No zoom, no brush, no
 * tooltip library. A vertical guide, the day, and the value, which is the only
 * question a fourteen-point series raises.
 */
export interface Series {
  id: string;
  /** Already in the reader's language: this component writes no words. */
  label: string;
  values: number[];
  total: string;
  /** A Tailwind text colour, so the line takes a theme token and not a hex. */
  tone: string;
}

const WIDTH = 720;
const HEIGHT = 200;
const PAD_TOP = 12;
const PAD_BOTTOM = 22;

export function TrendChart({
  series,
  /** Oldest first, one per point, already formatted by the page. */
  days,
  emptyLabel,
}: {
  series: Series[];
  days: string[];
  emptyLabel: string;
}) {
  const [shown, setShown] = useState(series[0]?.id ?? "");
  const [at, setAt] = useState<number | null>(null);

  const active = series.find((s) => s.id === shown) ?? series[0];
  if (!active || active.values.length < 2) {
    return <div className="text-sm text-muted-foreground py-10 text-center">{emptyLabel}</div>;
  }

  const values = active.values;
  // From zero, always, and never from a top of zero: an all-zero fortnight is a
  // flat line along the bottom rather than a division by nothing.
  const top = Math.max(1, ...values);
  const plot = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const stepX = WIDTH / (values.length - 1);
  const x = (i: number) => i * stepX;
  const y = (v: number) => PAD_TOP + plot - (v / top) * plot;

  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${WIDTH},${PAD_TOP + plot} L0,${PAD_TOP + plot} Z`;

  /*
    Which point the pointer is nearest, in the svg's own coordinates.

    `getBoundingClientRect` rather than `offsetX`, because the svg is scaled to
    its container by `viewBox` and the two are not the same number at any width
    but one. This is also why it survives the mirrored layout: the rectangle is
    where the element actually is on the screen.
  */
  /** The label for a point, or the last one, and never `undefined` in the DOM. */
  const dayAt = (index: number | null) => days[index ?? days.length - 1] ?? "";

  const track = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    const fraction = (event.clientX - box.left) / box.width;
    const index = Math.round(fraction * (values.length - 1));
    setAt(Math.max(0, Math.min(values.length - 1, index)));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {series.map((one) => {
          const on = one.id === active.id;
          return (
            <button
              key={one.id}
              type="button"
              onClick={() => {
                setShown(one.id);
                setAt(null);
              }}
              data-testid={`trend-pick-${one.id}`}
              aria-pressed={on}
              className={`inline-flex items-center gap-2 rounded-lg border px-3 min-h-11 sm:min-h-0 sm:py-2 text-start transition-colors ${
                on
                  ? "border-primary/50 bg-primary/10"
                  : "border-border bg-card hover:border-primary/30"
              }`}
            >
              <span
                aria-hidden="true"
                className={`w-2 h-2 rounded-full shrink-0 ${on ? one.tone : "text-muted-foreground"}`}
                style={{ backgroundColor: "currentColor" }}
              />
              <span className="text-xs text-muted-foreground">{one.label}</span>
              <span className="text-sm font-semibold tabular-nums">{one.total}</span>
            </button>
          );
        })}
      </div>

      {/*
        The readout, in the flow above the plot rather than floating over it.

        It was absolutely positioned in the top corner of the chart, which is
        exactly where a rising series ends: the number sat on top of the line
        it was describing, and against the edge of the box it was clipped. A
        chart that has to be read around is a chart with a decoration on it.
      */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-muted-foreground">{dayAt(at)}</span>
        <span className="text-xl font-semibold tabular-nums">
          {at !== null ? values[at] : values[values.length - 1]}
        </span>
      </div>

      <div className={active.tone} dir="ltr">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          /*
            Width-driven, height from the viewBox. The obvious alternative is a
            fixed height with `preserveAspectRatio="none"`, and it stretches
            everything that is not a straight line: the point marker becomes an
            ellipse whose eccentricity depends on the window width.
          */
          className="w-full block overflow-visible"
          role="img"
          aria-label={active.label}
          onPointerMove={track}
          onPointerLeave={() => setAt(null)}
        >
          {/*
            Three gridlines and no axis labels on them. The numbers that matter
            are the total on the chip and the value under the pointer; a y-axis
            in a card this size costs more width than it returns.
          */}
          {[0, 0.5, 1].map((fraction) => (
            <line
              key={fraction}
              x1="0"
              x2={WIDTH}
              y1={PAD_TOP + plot * fraction}
              y2={PAD_TOP + plot * fraction}
              stroke="currentColor"
              strokeWidth="1"
              opacity="0.12"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <path d={area} fill="currentColor" opacity="0.12" />
          <path
            d={line}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {at !== null ? (
            <g>
              <line
                x1={x(at)}
                x2={x(at)}
                y1={PAD_TOP}
                y2={PAD_TOP + plot}
                stroke="currentColor"
                strokeWidth="1"
                opacity="0.4"
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={x(at)} cy={y(values[at])} r="4" fill="currentColor" vectorEffect="non-scaling-stroke" />
            </g>
          ) : (
            <circle
              cx={x(values.length - 1)}
              cy={y(values[values.length - 1])}
              r="3.5"
              fill="currentColor"
            />
          )}
        </svg>
      </div>

      {/* The two ends of the fortnight, which is the only axis this needs. */}
      <div className="flex justify-between text-[11px] text-muted-foreground" dir="ltr">
        <span>{days[0]}</span>
        <span>{days[days.length - 1]}</span>
      </div>
    </div>
  );
}
