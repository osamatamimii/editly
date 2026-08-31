# The sound effects

Sixteen files, and not one of them is a recording. Every sample was computed by
`make-sfx.mjs` beside them — seeded noise, sine waves, filters and envelopes —
so running that script produces these exact bytes again.

The catalogue that gives each one a role, a weight and a place in the mix is
`artifacts/worker/src/sfx.ts`. `tools/sfx-test.mjs` checks the two against each
other, and against the files: a name in the catalogue with no file behind it,
or a file whose level has drifted from what the catalogue was balanced for, is
a failing check rather than a mix that quietly changed.

## Licence

**CC0 1.0 Universal — public domain dedication.**
<https://creativecommons.org/publicdomain/zero/1.0/>

To the extent possible under law, the authors of Editly have waived all
copyright and related or neighbouring rights to these sixteen audio files. They
may be used, modified and redistributed, commercially or otherwise, with no
attribution required.

## Why they are synthesised rather than downloaded

The contract already says this about music, and it says it as the reason there
is no music catalogue in this product: *a track we hand out is a licence we
bought on the customer's behalf.* A sound effect is the same claim with a
smaller file attached.

"CC0" on a download page is somebody else's assertion about somebody else's
recording. It is usually true. When it is not — a sample library re-uploaded, a
field recording with a song playing in the background, an account that later
retracts the dedication — the person who finds out is the customer whose video
gets a claim on it, months later, over four hundred milliseconds of whoosh that
Editly put there without being asked.

So the provenance here is not a link that can rot or a page that can change. It
is a script in this repository. Anybody can read what every sound is made of,
change a number, and get a different one.

That is what makes the dedication above ours to give.

## What is in the folder

| Role | Files | Where they land |
|---|---|---|
| whoosh | `whoosh-soft` `whoosh-fast` `whoosh-down` `whoosh-air` | the joins between cuts |
| impact | `impact-soft` `impact-deep` `impact-tight` `impact-snap` `thud` | the punch-ins |
| riser | `riser-short` `riser-mid` `riser-long` | leading into the first join, ending just before it |
| accent | `tick` `pop` `blip` `sweep-up` | the quiet palette's punctuation |

FLAC, mono, 48 kHz, every file peak-normalised to −3 dBFS. Lossless because
these are the *source* of a layer that is encoded once more on the way out, and
because FLAC needs no external library in any ffmpeg build — the sounds decode
in the worker image, in CI and on a laptop without a codec question.

The peak normalisation is what makes `soundEffects.gainDb` mean one thing: at
their loudest moment every sound in the catalogue is the same loudness, so the
number in the plan is a decision about the layer rather than about which file
happened to be picked. The per-sound `trimDb` in `sfx.ts` pulls back the dense
ones — a low sine rings for its whole length where a click does not — and those
numbers were measured, not guessed. The test re-measures them.

## Changing one

Edit the recipe in `make-sfx.mjs`, run it, and run `node tools/sfx-test.mjs`.
The suite will tell you if the sound you changed no longer sits at the weight
the catalogue balanced the layer around.
