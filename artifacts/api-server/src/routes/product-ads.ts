/**
 * The section for people who sell things.
 *
 * Every other door into this product starts with a recording. This one starts
 * with a shop: photographs of a product, a name, a price, and nobody on screen.
 * It is the same destination the embedded Shopify app reaches — `routes/
 * shopify.ts` gathers the photographs from a store's catalogue and this
 * gathers them from a person dragging files onto a page, and from the line
 * where the plan is built they are the same request.
 *
 * Which is why almost nothing is here. The photographs were uploaded by the
 * browser with the signed-in user's own token, confined by row-level security
 * to their own folder, and registered through the assets route that already
 * existed. What is left is the part no file can supply — the words — and the
 * handover to the same render policy every other render goes through.
 */
import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, projectsTable, assetsTable } from "@workspace/db";
import { CreateProductAdBody, CreateProductAdResponse } from "@workspace/api-zod";
import { currentUserId } from "../middlewares/auth";
import { startRenderForProject } from "../lib/start-render";
import { planForProductAd } from "../lib/product-ad";
import { MAX_IMAGES } from "../lib/shopify/product";

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
  const photos = (
    await db
      .select()
      .from(assetsTable)
      .where(and(eq(assetsTable.projectId, project.id), eq(assetsTable.userId, userId)))
      .orderBy(asc(assetsTable.createdAt))
  ).filter((asset) => asset.kind === "image");

  if (photos.length === 0) {
    // The refusal that names the fix. "I cannot" loses them; "add the photos
    // and I will build it" gets a video made.
    res.status(422).json({ error: "Add the product photos first, and I'll cut them into a video." });
    return;
  }

  /*
    A project that already holds a video is not a product ad, and turning one
    into the other would overwrite the pointer to somebody's upload.

    Allowed when there is no source yet, or when the source is already one of
    this project's own photographs — which is what a second attempt looks like.
  */
  const alreadyAPhoto = photos.some((photo) => photo.path === project.videoPath);
  if (project.videoPath && !alreadyAPhoto) {
    res.status(409).json({ error: "This project already has a video in it. Start a new one for a product ad." });
    return;
  }

  const chosen = photos.slice(0, MAX_IMAGES);
  const title = (body.data.title ?? project.title).trim().slice(0, 120) || "Your product";
  const price = body.data.price?.trim() ? body.data.price.trim() : null;

  await db
    .update(projectsTable)
    .set({
      title,
      platform: body.data.platform,
      /*
        The first photograph, and the column means what it has always meant: the
        object this project's renders start from. The worker replaces it with
        the assembled reel before the first probe and never opens it — see the
        `stillsReel` branch in the worker's `processJob`.
      */
      videoPath: chosen[0]!.path,
      // What the source *will* be once it is assembled. The ceiling and the
      // month's allowance are judged against this, and they should be: it is
      // the length that gets billed.
      duration: body.data.targetSeconds,
    })
    .where(and(eq(projectsTable.id, project.id), eq(projectsTable.userId, userId)));

  const [updated] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, project.id), eq(projectsTable.userId, userId)));

  const outcome = await startRenderForProject(
    userId,
    updated!,
    planForProductAd({ title, price }, chosen.map((photo) => photo.id), {
      platform: body.data.platform,
      targetSeconds: body.data.targetSeconds,
    }),
    req.log,
  );

  if (!outcome.ok) {
    res.status(outcome.status).json(outcome.body);
    return;
  }

  res.status(202).json(
    CreateProductAdResponse.parse({ projectId: project.id, jobId: outcome.job.id, photos: chosen.length }),
  );
});

export default router;
