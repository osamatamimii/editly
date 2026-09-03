import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";

/**
 * One row per Shopify shop that has installed the app.
 *
 * This is the whole of the integration's state. Everything else a merchant
 * makes — projects, assets, jobs, exports — lands in the tables that already
 * exist, under an account id derived from the shop domain rather than stored
 * here (see `lib/shopify/domain.ts`). That is deliberate: a mapping column
 * would be a row that can go missing, and a shop whose id could not be looked
 * up would see an empty account with nothing anywhere having failed.
 *
 * ## The token
 *
 * `access_token` is an offline token: it outlives the staff member's session,
 * which it has to, because the work this app does happens on a queue minutes
 * after the merchant closed the tab.
 *
 * It is stored as it arrives. Encrypting it with a key that sits in the same
 * environment as the database connection string would move the secret from one
 * place an attacker who is already inside can read to another, and would let
 * this comment claim a protection that is not there. What actually protects it
 * is that nothing but the API server can reach this table, and that a stolen
 * token is scoped to `read_products` on one shop.
 *
 * ## Uninstalls
 *
 * The row is kept and marked rather than deleted. Shopify sends `shop/redact`
 * 48 hours after an uninstall and that is when the shop's data goes; between
 * the two, a merchant who reinstalls — which is common, and is usually somebody
 * who uninstalled to fix something — gets their projects back rather than an
 * empty account. `uninstalled_at` is also the answer to "why did this shop stop
 * rendering", which is otherwise a question with no evidence behind it.
 */
export const shopifyShopsTable = pgTable(
  "shopify_shops",
  {
    /** `example.myshopify.com`, lowercase. Validated before it ever gets here. */
    shop: text("shop").primaryKey(),

    /**
     * The account id this shop's rows are written under.
     *
     * Derived from the domain, and stored anyway — not as the source of truth
     * but as the thing that makes this table readable. An operator looking at a
     * project's `user_id` can find the shop it belongs to with a join instead
     * of by re-running a hash by hand.
     */
    userId: uuid("user_id").notNull(),

    accessToken: text("access_token").notNull(),
    /** What the token can actually do, as Shopify granted it, not as we asked. */
    scopes: text("scopes").notNull().default(""),

    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set on `app/uninstalled`; cleared when they come back. */
    uninstalledAt: timestamp("uninstalled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index("shopify_shops_user_idx").on(t.userId)],
);

export type ShopifyShop = typeof shopifyShopsTable.$inferSelect;
