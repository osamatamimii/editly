import { type ComponentType } from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { ThemeProvider } from "@/lib/theme";
import NotFound from "@/pages/not-found";

import Home from "@/pages/home";
import Login from "@/pages/login";
import Dashboard from "@/pages/dashboard";
import ProjectEditor from "@/pages/project-editor";
import ExportPage from "@/pages/export";
import AccountPage from "@/pages/account";
import AdminPage from "@/pages/admin";

const queryClient = new QueryClient();

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
