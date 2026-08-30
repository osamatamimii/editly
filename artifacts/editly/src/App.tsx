import { type ComponentType, Suspense, lazy } from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { ThemeProvider } from "@/lib/theme";
import NotFound from "@/pages/not-found";

import Home from "@/pages/home";

/*
 * Everything behind the front door is fetched when somebody walks through it.
 *
 * This file used to import all seven pages at the top, so one bundle carried
 * the landing page, the editor, the export screen, the account screen and the
 * admin console — 772kB of JavaScript, 228kB over the wire, parsed and
 * executed before anyone could scroll the marketing page. Most of it belongs
 * to screens that only a signed-in person ever opens, and the admin console is
 * for exactly one account. It measured as ~680ms of blocked main thread on a
 * reload at 4x CPU throttle, which is what "it hangs when I refresh" is.
 *
 * The landing page stays a static import: it is what an unauthenticated
 * visitor sees first, and making the first screen wait on a second round trip
 * to fetch itself would be trading one delay for a worse one. Everything else
 * is a chunk that arrives with the click that needs it, behind a spinner that
 * already existed for the auth check.
 */
const Login = lazy(() => import("@/pages/login"));
const Dashboard = lazy(() => import("@/pages/dashboard"));
const ProjectEditor = lazy(() => import("@/pages/project-editor"));
const ExportPage = lazy(() => import("@/pages/export"));
const AccountPage = lazy(() => import("@/pages/account"));
const AdminPage = lazy(() => import("@/pages/admin"));

const queryClient = new QueryClient();

/** The same spinner the auth gate shows, so a chunk arriving looks like a
 *  session being restored rather than a second kind of waiting. */
function RouteFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-primary" />
    </div>
  );
}

/**
 * Gates a route on an authenticated session.
 *
 * While the session is still being restored we render a spinner rather than
 * redirecting — otherwise a signed-in user who reloads the page would be
 * bounced to the login screen for a frame before being sent back.
 */
function Protected({ component: Component }: { component: ComponentType }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) return <Redirect to="/login" />;

  return <Component />;
}

function Router() {
  const { user, isLoading } = useAuth();

  return (
    <Suspense fallback={<RouteFallback />}>
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/login">
        {isLoading ? null : user ? <Redirect to="/dashboard" /> : <Login />}
      </Route>
      <Route path="/dashboard">
        <Protected component={Dashboard} />
      </Route>
      <Route path="/project/:id">
        <Protected component={ProjectEditor} />
      </Route>
      <Route path="/export/:id">
        <Protected component={ExportPage} />
      </Route>
      <Route path="/account">
        <Protected component={AccountPage} />
      </Route>
      {/*
        Registered for everyone, and refused by the server for almost everyone.
        There is no client-side admin check here on purpose: the page asks the
        API and renders the ordinary not-found screen when the API says no, so
        reading the bundle tells an attacker nothing they could not have
        guessed from the URL.
      */}
      <Route path="/admin">
        <Protected component={AdminPage} />
      </Route>
      <Route component={NotFound} />
    </Switch>
    </Suspense>
  );
}

function App() {
  // The class on <html> is set by the inline script in index.html, before the
  // first paint, and maintained from here on by ThemeProvider. This used to be
  // an effect that forced `dark` on mount, which is what made the theme
  // unswitchable — it would have reapplied dark on every remount.
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <TooltipProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <div className="min-h-screen bg-background text-foreground selection:bg-primary/30 transition-colors duration-300">
                <Router />
              </div>
            </WouterRouter>
            <Toaster />
          </TooltipProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
