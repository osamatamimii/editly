/**
 * The clip library.
 *
 * One file per screen, and that is a bundling decision as much as a filing
 * one. The copy table was a single module, and a single module is a single
 * unit to a bundler: `not-found.tsx` and the crash screen are in the first
 * chunk the landing page downloads, so importing one sentence from that module
 * pulled every sentence in the product into it — measured at 17kB of gzip, in
 * a chunk `tools/speed-test.mjs` holds under 200kB. Split, each screen's words
 * travel in that screen's chunk.
 *
 * The rules are in `lib/app-copy.ts`, which is the door to this folder and
 * explains what is deliberately not written here.
 */
import { phrase as p, template as f } from "@/lib/landing-copy";

  /** The clip library: what came out of every recording, in one wall. */
export const CLIPS = {
  title: p("المقاطع", "Clips"),
  lead: p(
    "كل مقطع قُصّ من كل تسجيل، الأحدث أوّلًا. شغّل واحدًا، أو احفظه، أو افتح التسجيل الذي جاء منه.",
    "Every clip cut out of every recording, newest first. Play one, save it, or open the take it came from.",
  ),
  untitled: p("مقطع بلا عنوان", "Untitled clip"),
  save: p("احفظ", "Save"),
  emptyTitle: p("لم يُقصّ شيء بعد", "Nothing cut yet"),
  emptyLeadStart: p("افتح تسجيلًا طويلًا واطلب مقاطع، أو اضغط ", "Open a long recording and ask for clips, or press "),
  emptyLeadAction: p("ثلاثة مقاطع", "Three clips"),
  emptyLeadEnd: p(
    " في صفّ اللمسات. كل لحظة تعود منشورًا قائمًا بذاته، بعنوان ممّا قيل فيها.",
    " in the looks row. Each moment comes back as its own post, titled by what is said in it.",
  ),
  capped: f<[number, number]>(
    (shown, total) => `نعرض أحدث ${shown} من ${total}. والبقيّة في التسجيلات التي جاءت منها.`,
    (shown, total) => `Showing the newest ${shown} of ${total}. The rest are in the recordings they came from.`,
  ),
} as const;
