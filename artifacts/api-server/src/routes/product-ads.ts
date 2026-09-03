/**
 * The section for people who sell things.
 *
 * Every other door into this product starts with a recording of somebody
 * talking, and the work is finding the good parts. This one starts with a
 * shop: clips of a product, photographs of it, a name, a price, and a sentence
 * saying what the advertisement should be like.
 *
 * It is the same destination the embedded Shopify app reaches — `routes/
 * shopify.ts` gathers the material from a store's catalogue and this gathers
 * it from a person dragging files onto a page, and from the line where the
 * plan is built they are the same request.
 *
 * **A clip is required, and photographs alone are refused.** That is the whole
 * correction this file carries. A dropshipper has supplier footage and phone
 * clips and somebody holding the thing; the photographs cover the gaps. An
 * advertisement made of stills alone is the weaker product, and offering it as
 * the main road taught merchants that this tool makes slideshows.
 *
 * Which is why almost nothing is here. The files were uploaded by the browser
 * with the signed-in user's own token, confined by row-level security to their
 * own folder, and registered through the assets route that already existed.
 * What is left is the part no file can supply — the words — and the handover
 * to the same render policy every other render goes through.
 */
import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, projectsTable, assetsTable } from "@workspace/db";
import { CreateProductAdBody, CreateProductAdResponse } from "@workspace/api-zod";
import { currentUserId } from "../middlewares/auth";
import { startRenderForProject } from "../lib/start-render";
import { planForProductAd } from "../lib/product-ad";
import { withDirection } from "../lib/direct";
import { createPlanner } from "../lib/planner";
import { plannerAssets } from "../lib/planner-assets";
import { MAX_IMAGES } from "../lib/shopify/product";

/**
 * One planner for the process, exactly as the messages route holds one: it
 * reads its key once at startup, and falls back to the keyword matcher when
 * there is none. A merchant's sentence goes through the same door a
 * conversation does, because it is the same question.
 */
const planner = createPlanner();

const router: IRouter = Router();

router.post("/product-ads", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const body = CreateProductAdBody.safeParse({ ...req.body, id: req.body?.id ?? "" });
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, body.data.id), eq(projectsTable.userId, userId)));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  /*
    Their order, which is the order they uploaded them in.

    A merchant who dragged the front of the product in first meant it to open
    the advertisement, and sorting by anything else — size, resolution, which
    looks most like a hero shot — is this code overruling the only person who
    has seen the product. It is also the commonest way these tools produce
    something the merchant does not recognise.
  */
  const material = await db
    .select()
    .from(assetsTable)
    .where(and(eq(assetsTable.projectId, project.id), eq(assetsTable.userId, userId)))
    .orderBy(asc(assetsTable.createdAt));
  const clips = material.filter((asset) => asset.kind === "video");
  const photos = material.filter((asset) => asset.kind === "image");

  /*
    A clip is required, and photographs alone are refused.

    Not a limitation: a preference, and the product saying which of the two
    advertisements it believes in. A dropshipper has supplier footage, phone
    clips, somebody holding the thing — and the photographs are what covers the
    gaps between them. Building a slideshow when they had footage sitting in
    the same folder is the worse video of the two, made confidently.

    The sentence names the fix rather than the rule, because a merchant who is
    told "add a clip and I will cut it" adds a clip.
  */
  if (clips.length === 0) {
    res.status(422).json({
      error:
        photos.length > 0
          ? "Add at least one clip of the product, and I'll cut your photos in over it."
          : "Add a clip of the product to start, and photos if you have them.",
    });
    return;
  }

  /*
    A project that already holds somebody's own upload is not a product ad.

    Allowed when there is no source yet, or when the source is already one of
    this project's own clips — which is what a second attempt looks like.
  */
  const alreadyOurs = material.some((asset) => asset.path === project.videoPath);
  if (project.videoPath && !alreadyOurs) {
    res.status(409).json({ error: "This project already has a video in it. Start a new one for a product ad." });
    return;
  }

  const source = clips[0]!;
  const title = (body.data.title ?? project.title).trim().slice(0, 120) || "Your product";
  const price = body.data.price?.trim() ? body.data.price.trim() : null;

  await db
    .update(projectsTable)
    .set({
      title,
      platform: body.data.platform,
      // The first clip, and the column means what it has always meant: the
      // object this project's renders start from.
      videoPath: source.path,
      /*
        The source's own length when the browser measured it, and the ad's
        length when it did not.

        This is what the month's allowance and the upload ceiling are judged
        against, so it has to be the footage rather than the target: an
        advertisement cut down to fifteen seconds out of two minutes still
        costs two minutes of decoding, and the worker re-checks the number
        against the file it actually downloads.
      */
      duration: source.durationSeconds ?? body.data.targetSeconds,
    })
    .where(and(eq(projectsTable.id, project.id), eq(projectsTable.userId, userId)));

  const [updated] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, project.id), eq(projectsTable.userId, userId)));

  /*
    What they asked for, over what this material wants.

    The sentence goes through the same planner a conversation does — model
    where there is a key, keyword matcher where there is not — and the product
    ad is the direction underneath it. `withDirection` drops any of our
    operations whose *type* they already spoke about, so "keep her voice and
    put big subtitles on it" gets their captions and our framing, price card
    and fade, and nothing of ours quietly overrules a sentence they typed.
  */
  const spoken = body.data.description?.trim()
    ? await planner.plan(body.data.description.trim(), {
        defaultPlatform: body.data.platform,
        assets: (await plannerAssets(project.id)) as never,
      })
    : { operations: [], willDo: [], degraded: undefined as string | undefined };
  if (spoken.degraded) req.log?.warn({ reason: spoken.degraded }, "planner fell back to keywords");

  const direction = planForProductAd(
    { title, price },
    {
      clipIds: clips.map((clip) => clip.id),
      photoIds: photos.slice(0, MAX_IMAGES).map((photo) => photo.id),
      sourceSeconds: source.durationSeconds ?? null,
    },
    { platform: body.data.platform, targetSeconds: body.data.targetSeconds },
  );

  /*
    Except the price, which is not a style.

    `withDirection` works by operation type, and the product's name and its
    price are both `motionTitle` — so a sentence that asks for any words on
    screen would drop both of ours, including the number the advertisement is
    asking the viewer to accept. Their title wins, because those are their
    words about their product. The price card is put back, because it is data
    the merchant typed into a field for exactly this purpose.
  */
  const merged = withDirection(spoken.operations as never, direction);
  const priceCard = direction.find(
    (op) => op.type === "motionTitle" && price !== null && op.text === price,
  );
  const operations =
    priceCard && !merged.includes(priceCard) ? [...merged, priceCard] : merged;

  const outcome = await startRenderForProject(userId, updated!, operations, req.log);

  if (!outcome.ok) {
    res.status(outcome.status).json(outcome.body);
    return;
  }

  res.status(202).json(
    CreateProductAdResponse.parse({
      projectId: project.id,
      jobId: outcome.job.id,
      clips: clips.length,
      photos: Math.min(photos.length, MAX_IMAGES),
    }),
  );
});

export default router;
