"""
Where the person is, frame by frame.

Reframing a landscape take to 9:16 throws away most of the width, and which
part it throws away is the whole difference between a clip that looks shot
vertically and one that looks cropped by a machine. Until now that decision was
made from luma gradient and frame-to-frame change — an honest measurement of
where the picture is *busy*, which is not the same thing as where the person
is, and which will happily frame a moving curtain.

This reads faces instead, and it does it locally: a face box per sampled frame
is not something an API can return at any sane price, and sending someone's
footage to one to find out where their own face is would be a poor trade even
if it were free.

The detector is OpenCV's Haar cascade rather than a modern DNN, for one reason
that outweighs its accuracy: it ships inside the opencv package. Nothing is
downloaded at build time, nothing is fetched at run time, and the container has
no dependency on a model host still being up in a year. It is weaker in profile
and in poor light, which is exactly why the caller treats a low detection rate
as "use the old measurement" rather than as gospel — see subject.ts. Swapping in
YuNet or BlazeFace later is a change to this file alone; the JSON contract does
not move.

Frames arrive as raw BGR on stdin, produced by ffmpeg, so there is no video
decoding here and no second copy of the file on disk.

Usage: track-subject.py WIDTH HEIGHT
Emits: one JSON object per line — {"i": frame, "cx": 0..1, "cy": 0..1,
"s": size as a fraction of width} — or {"i": frame} when nothing was found.
"""
import json
import os
import sys


def main() -> int:
    if len(sys.argv) != 3:
        sys.stderr.write("usage: track-subject.py WIDTH HEIGHT\n")
        return 2

    width, height = int(sys.argv[1]), int(sys.argv[2])
    if width <= 0 or height <= 0:
        sys.stderr.write("width and height must be positive\n")
        return 2

    try:
        import cv2
        import numpy as np
    except ImportError as error:
        # The worker treats a non-zero exit as "no tracking available" and falls
        # back, so this is a degradation rather than a failure — but it should
        # say which import was missing, because a silently untracked render
        # looks exactly like a tracked one that found nobody.
        sys.stderr.write(f"vision libraries unavailable: {error}\n")
        return 3

    cascades = cv2.data.haarcascades
    frontal = cv2.CascadeClassifier(os.path.join(cascades, "haarcascade_frontalface_default.xml"))
    profile = cv2.CascadeClassifier(os.path.join(cascades, "haarcascade_profileface.xml"))
    if frontal.empty():
        sys.stderr.write("the face cascade did not load\n")
        return 3

    # A face smaller than this in a frame this size is a bystander or a
    # false positive, not the subject of a talking-head clip.
    min_side = max(24, int(min(width, height) * 0.08))
    min_size = (min_side, min_side)

    def detect(gray):
        """Largest face, or None. Frontal first, then either profile."""
        boxes = frontal.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=min_size)
        if len(boxes) == 0:
            boxes = profile.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=min_size)
        if len(boxes) == 0:
            # The profile cascade is trained on one direction only, so a head
            # turned the other way is invisible to it until the frame is
            # mirrored. Cheap, and it roughly doubles profile coverage.
            flipped = cv2.flip(gray, 1)
            boxes = profile.detectMultiScale(flipped, scaleFactor=1.1, minNeighbors=5, minSize=min_size)
            if len(boxes) > 0:
                boxes = [(width - x - w, y, w, h) for (x, y, w, h) in boxes]
        if len(boxes) == 0:
            return None
        return max(boxes, key=lambda b: b[2] * b[3])

    frame_bytes = width * height * 3
    out = sys.stdout
    index = 0
    reader = sys.stdin.buffer

    while True:
        raw = reader.read(frame_bytes)
        if not raw or len(raw) < frame_bytes:
            break

        frame = np.frombuffer(raw, dtype=np.uint8).reshape((height, width, 3))
        gray = cv2.equalizeHist(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))

        box = detect(gray)
        if box is None:
            out.write(json.dumps({"i": index}) + "\n")
        else:
            x, y, w, h = (int(v) for v in box)
            out.write(
                json.dumps(
                    {
                        "i": index,
                        "cx": round((x + w / 2) / width, 4),
                        "cy": round((y + h / 2) / height, 4),
                        "s": round(w / width, 4),
                    }
                )
                + "\n"
            )
        index += 1

    out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
