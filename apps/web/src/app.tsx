/**
 * Application root.
 *
 * Providers are ordered so that routing decisions can rely on authenticated
 * state: toasts first (nothing depends on them), then auth, then the router.
 */
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { ToastProvider } from './components/ui';
import { AuthProvider } from './state/auth-context';
import { AppLayout } from './components/app-layout';
import { RequireAuth, RequireVerifiedEmail } from './components/route-guards';
import { DashboardPage } from './pages/dashboard';
import { ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage, VerifyEmailPage } from './pages/auth-pages';
import { ProjectWorkspacePage } from './pages/project-workspace';
import { AssetLibraryPage } from './pages/asset-library';
import { ExportsPage } from './pages/exports';
import { ActivityPage } from './pages/activity';
import { SettingsPage } from './pages/settings';
import { NotFoundPage } from './pages/not-found';

export function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            {/* Public authentication surfaces. */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/verify-email" element={<VerifyEmailPage />} />

            {/* The authenticated product. */}
            <Route
              element={
                <RequireAuth>
                  <AppLayout />
                </RequireAuth>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="projects/:projectId" element={<ProjectWorkspacePage />} />
              <Route path="assets" element={<AssetLibraryPage />} />
              <Route path="exports" element={<ExportsPage />} />
              <Route path="activity" element={<ActivityPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>

            <Route path="/" element={<Navigate to="/" replace />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  );
}

// Re-exported so route modules do not need to reach into the guards file.
export { RequireVerifiedEmail };
