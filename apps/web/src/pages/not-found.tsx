import { Link } from 'react-router-dom';

import { EmptyState } from '../components/ui';

/** Shown for any unmatched path. */
export function NotFoundPage() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <div className="card" style={{ maxWidth: 480, width: '100%' }}>
        <EmptyState
          icon="404"
          title="Page not found"
          description="That address does not match anything in Zyvano. It may have been renamed or removed."
          action={
            <Link to="/" className="btn btn--primary">
              Back to the studio
            </Link>
          }
        />
      </div>
    </div>
  );
}
