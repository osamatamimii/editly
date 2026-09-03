import { type ComponentType, Suspense, lazy, useEffect } from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { ThemeProvider } from "@/lib/theme";
import { LanguageProvider } from "@/lib/language";
import NotFound from "@/pages/not-found";
import { ErrorBoundary, watchForCrashes } from "@/components/error-boundary";

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
/*
  Public, like the login screen it belongs to: whoever opens a recovery link
  has no session yet, and `Protected` would bounce them to /login and lose the
  token in the fragment on the way.
*/
const ResetPassword = lazy(() => import("@/pages/reset-password"));
/*
  Public for the same reason as the password reset, and one more: the person
  following an unsubscribe link is in an email client with no session of ours,
  possibly on a different device, and asking them to sign in to stop receiving
  mail is how a legal requirement becomes a complaint.
*/
const Unsubscribe = lazy(() => import("@/pages/unsubscribe"));
const Dashboard = lazy(() => import("@/pages/dashboard"));
const Onboarding = lazy(() => import("@/pages/onboarding"));
const ProjectEditor = lazy(() => import("@/pages/project-editor"));
const ExportPage = lazy(() => import("@/pages/export"));
const AccountPage = lazy(() => import("@/pages/account"));
const ClipsPage = lazy(() => import("@/pages/clips"));
const ScheduledPage = lazy(() => import("@/pages/scheduled"));
/*
  The shop door.

  A merchant has no recording to upload, and the create-project dropzone takes
  video only — so until this route existed the whole product was closed to
  them. It is also the screen the embedded Shopify app renders, which is why it
  is a page of its own rather than a mode of the editor.
*/
const ProductAdsPage = lazy(() => import("@/pages/product-ads"));
const AdminPage = lazy(() => import("@/pages/admin"));
/*
  Public, and not behind `Protected`: a privacy policy a reader has to sign in
  to read is a privacy policy nobody can check before deciding whether to sign
  up — and every platform review reads it while signed out.
*/
const PrivacyPage = lazy(() => import("@/pages/privacy"));
const TermsPage = lazy(() => import("@/pages/terms"));

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
      <Route path="/reset-password" component={ResetPassword} />
      <Route path="/unsubscribe/:token" component={Unsubscribe} />
      <Route path="/dashboard">
        <Protected component={Dashboard} />
      </Route>
      {/*
        Behind `Protected` like everything else. The first-run screen creates a
        project, so it needs a session — and an unauthenticated visitor reaching
        it would get a create that 401s rather than a sign-in prompt.
      */}
      <Route path="/onboarding">
        <Protected component={Onboarding} />
      </Route>
      <Route path="/project/:id">
        <Protected component={ProjectEditor} />
      </Route>
      <Route path="/export/:id">
        <Protected component={ExportPage} />
      </Route>
      <Route path="/clips">
        <Protected component={ClipsPage} />
      </Route>
      <Route path="/scheduled">
        <Protected component={ScheduledPage} />
      </Route>
      <Route path="/ads">
        <Protected component={ProductAdsPage} />
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
      {/*
        The console's other seven screens, on the same component.

        One route each would be seven copies of the same three lines and a
        seventh chance to forget `Protected`; the page reads the segment itself
        and renders the ordinary not-found screen for a segment it does not
        know, which is the same answer this route already gives everyone who is
        not an admin.
      */}
      <Route path="/admin/:section">
        <Protected component={AdminPage} />
      </Route>
      <Route path="/privacy" component={PrivacyPage} />
      <Route path="/terms" component={TermsPage} />
      <Route component={NotFound} />
    </Switch>
    </Suspense>
  );
}

function App() {
  /*
    The two kinds of failure a boundary cannot see.

    An error boundary catches what is thrown while React renders. It does not
    catch an event handler, a timer, or a promise nobody awaited, and in an app
    that spends its life waiting on uploads those are the common case. Wired
    here rather than at module scope so that importing this file has no side
    effect, and so that the listeners come off if the app is ever unmounted.
  */
  useEffect(() => watchForCrashes(), []);

  // The class on <html> is set by the inline script in index.html, before the
  // first paint, and maintained from here on by ThemeProvider. This used to be
  // an effect that forced `dark` on mount, which is what made the theme
  // unswitchable — it would have reapplied dark on every remount.
  return (
    <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <TooltipProvider>
            {/*
              Inside the router, because the language a screen is written in is
              a property of the route: the document declares Arabic on the
              screens that have Arabic on them and English everywhere else, and
              only something that knows the current path can decide that. The
              Toaster moved in with it — a refusal is copy like any other, and
              it was the one thing on screen the provider could not reach.
            */}
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <LanguageProvider>
                <div className="min-h-screen bg-background text-foreground selection:bg-primary/30 transition-colors duration-300">
                  <Router />
                </div>
                <Toaster />
              </LanguageProvider>
            </WouterRouter>
          </TooltipProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
