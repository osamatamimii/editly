# The caption face

`Montserrat-Black.otf` is the font every Latin caption this product burns is
drawn in. It is in the repository rather than installed from the distribution,
and that is a decision with two halves.

**The arithmetic depends on this exact cut.** `caption-layout.ts` sizes every
caption by cap height and converts to a nominal size through a per-face ratio —
0.54 for Montserrat Black — measured from *these bytes*, by rendering through
libass and counting pixels. A packaged font is whatever version the archive
happens to hold on the day the image is built, and a differently proportioned
revision would not break anything: every caption in the product would simply
render the wrong size. The Dockerfile checks the ratio for that reason, and
pinning the file means the check has nothing left to catch.

**And a build should not depend on a package name.** The image installs the
file; there is no `apt-get` line to go stale, and nothing to resolve at build
time that could resolve differently next month.

Montserrat is licensed under the SIL Open Font License 1.1 — `Montserrat-OFL.txt`
here, which the licence requires to travel with the font. Redistribution is
explicitly permitted; selling the font on its own is not, and we do not.

Upstream: https://github.com/JulietaUla/Montserrat
