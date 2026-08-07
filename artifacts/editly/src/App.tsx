import { useEffect, type ComponentType } from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import NotFound from "@/pages/not-found";

import Home from "@/pages/home";
import Login from "@/pages/login";
import Dashboard from "@/pages/dashboard";
import ProjectEditor from "@/pages/project-editor";
import ExportPage from "@/pages/export";

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
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  useEffect(() => {
    // Force dark mode
    document.documentElement.classList.add('dark');
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <div className="min-h-screen bg-background text-foreground selection:bg-primary/30">
              <Router />
            </div>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
