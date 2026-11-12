import "./Skeleton.css";

/**
 * Grey placeholders in the shape of what is loading, so the page does not
 * jump when it arrives. Hidden from screen readers, which hear the label.
 */
export function SkeletonCards({ cards = 2, rows = 4, label = "Loading…" }: { cards?: number; rows?: number; label?: string }) {
  return (
    <div className="skeleton" role="status">
      <span className="sr-only">{label}</span>
      <div className="skeleton-line skeleton-heading" aria-hidden="true" />
      <div className="grid" aria-hidden="true">
        {Array.from({ length: cards }, (_, c) => (
          <div key={c} className="card skeleton-card">
            <div className="skeleton-card-head">
              <span className="skeleton-line skeleton-title" />
            </div>
            {Array.from({ length: rows }, (_, r) => (
              <div key={r} className="skeleton-row">
                <span className="skeleton-dot" />
                <span className="skeleton-text">
                  <span className="skeleton-line" style={{ width: `${30 + ((r * 17 + c * 11) % 30)}%` }} />
                  <span className="skeleton-line skeleton-sub" style={{ width: `${45 + ((r * 13 + c * 7) % 30)}%` }} />
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
