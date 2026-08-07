export type PlanKey = "starter" | "pro" | "scale";

export const PLAN_LIMITS: Record<
  PlanKey,
  { videosPerMonth: number; editsPerVideo: number | null; pricePerMonth: number }
> = {
  starter: { videosPerMonth: 10, editsPerVideo: 10, pricePerMonth: 12 },
  pro: { videosPerMonth: 40, editsPerVideo: 20, pricePerMonth: 29 },
  scale: { videosPerMonth: 100, editsPerVideo: null, pricePerMonth: 59 },
};

export function isPlanKey(value: string): value is PlanKey {
  return value in PLAN_LIMITS;
}
