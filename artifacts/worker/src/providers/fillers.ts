/**
 * What counts as a hesitation rather than a word.
 *
 * This is one file because it used to be three. The same eight-item set was
 * copy-pasted into the Deepgram provider, the ElevenLabs provider and the
 * merge — with three *different* normalisers in front of it — and a list that
 * exists in three places is a list that is about to disagree with itself. It
 * is also the file that answers a question with real consequences: a word
 * marked as a filler is dropped from the captions, ends a caption group, and
 * is excluded from the scoring that picks the highlight window, chooses the
 * clips, and **writes their titles from the first words spoken**. Get this
 * wrong in one direction and a caption keeps an "um"; get it wrong in the
 * other and a clip is titled with a word the person meant.
 *
 * ## Why the Arabic half is deliberately small
 *
 * `dropFillers` is set on every captions plan this product makes, and until
 * now it did nothing at all for Arabic: the list was English, and Deepgram's
 * filler-word marking is documented English-only, so an Arabic caption kept
 * every hesitation and a clip could be titled with one.
 *
 * The obvious fix — add «يعني», «إيه», «طيب» — is the same mistake as reading
 * «ترجم» for «ترجمة». Every one of those is also an ordinary word: «يعني»
 * means *means*, «إيه» is *yes* in the Levant and *what* in Egypt, «طيب» is
 * *fine*. Dropping a word somebody actually said is worse than keeping a
 * hesitation they did not mean, because the second is untidy and the first
 * changes what they said.
 *
 * So only **non-lexical vocalisations** qualify, and they are recognised by
 * the one property that separates a held sound from a word: **the letter is
 * repeated**. «آآ» and «ااا» and «ممم» are sounds; «اه» and «آه» are not on
 * the list, because in speech they are usually *yes*. That leaves some
 * hesitations in — which is the side of the line to be wrong on.
 */

/**
 * The English set, unchanged from the three copies it replaces. Deepgram marks
 * these itself when it is asked to; this list is what the providers that do
 * not mark them are read against.
 */
const ENGLISH = new Set(["um", "uh", "mm", "hmm", "er", "ah", "uhh", "umm"]);

/**
 * One letter held: «آآ», «ااا», «ممم», «ههه».
 *
 * The doubling is the whole test. No Arabic word is a single letter written
 * twice, so this cannot reach one.
 */
const HELD_LETTER = /^([اأآإمه])\1+$/;

/**
 * An alef held and then released: «اااه», «آآه», «اهه».
 *
 * A repeat is required on one side or the other, which is what keeps «اه» and
 * «آه» — *yes*, in most of the dialects this product will meet first — out of
 * it.
 */
const HELD_THEN_RELEASED = /^(?:[اأآإ]{2,}ه+|[اأآإ]+ه{2,})$/;

/** Tatweel is a stretched line, not a letter: «آاـاـه» is «آااه» held longer. */
const TATWEEL = /ـ/g;

/**
 * Arabic short vowels and the shadda — the marks that spell a word out.
 *
 * A held sound is never written with them: «ممم» and «آآ» carry none. So their
 * presence is proof the token is a spelled, meant word, not a vocalisation —
 * and it is the one signal that survives stripping. «مِمَّ» (*from what*) is
 * two mims with a kasra, a shadda and a fatha; strip the marks, as the letter
 * filter below does, and it collapses to «مم», a doubled letter that reads as a
 * held sound and gets the word deleted. Checked on the raw text, before
 * anything is stripped.
 */
const HARAKAT = /[\u064B-\u0652\u0670]/;

/**
 * Everything that is not a letter or a digit, which is how all three original
 * call sites differed: one stripped punctuation, one stripped everything
 * non-alphanumeric, one also stripped apostrophes first. Same intent, three
 * spellings — so it is spelled once here.
 */
const NOT_A_LETTER = /[^\p{L}\p{N}]/gu;

/** Is this word a sound rather than something the person meant to say? */
export function isFiller(text: string): boolean {
  // A held sound carries no short vowels; a spelled word may. So a token with
  // harakat on it is a word — even when stripping those marks would leave a
  // doubled letter that reads as a held sound, which is exactly how «مِمَّ»
  // (*from what*) was being deleted. English fillers have no marks, so this
  // never touches them.
  if (HARAKAT.test(text)) return false;
  const bare = text.replace(NOT_A_LETTER, "").replace(TATWEEL, "");
  if (bare.length === 0) return false;
  if (ENGLISH.has(bare.toLowerCase())) return true;
  return HELD_LETTER.test(bare) || HELD_THEN_RELEASED.test(bare);
}
