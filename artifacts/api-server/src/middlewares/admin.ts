import type { RequestHandler } from "express";
import { isAdmin } from "../lib/admin";
import { currentUserId } from "./auth";

/**
 * Refuses everything that is not on the allowlist — as 404, not 403.
 *
 * The same rule the rest of the product follows for other people's rows: a
 * status code is information, and "403 Forbidden" tells an attacker that the
 * path they guessed is real and that the only thing between them and it is
 * being the right person. 404 tells them nothing at all, and costs the one
 * person who is an admin nothing, because they never see it.
 *
 * Mounted so that it runs after `requireAuth`: an anonymous request has already
 * been answered 401 by then, which is not a leak — every route in the product
 * answers an unauthenticated caller the same way.
 */
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!isAdmin(currentUserId(req))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
};
