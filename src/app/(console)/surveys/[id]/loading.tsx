import { Skeleton } from "@astryxdesign/core/Skeleton";

/** Shared across all 6 pipeline-stage pages — shown immediately on tab
 * switch while the server component fetches, instead of a blank screen. */
export default function SurveyLoading() {
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Skeleton width={160} height={16} />
        <Skeleton width={280} height={28} />
        <Skeleton width="100%" height={36} />
      </div>
      <Skeleton width="100%" height={120} />
      <Skeleton width="100%" height={120} />
    </main>
  );
}
