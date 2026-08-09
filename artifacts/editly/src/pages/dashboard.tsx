import { useState } from "react";
import { Link, useLocation } from "wouter";
import { format } from "date-fns";
import { 
  useListProjects, 
  useGetDashboardStats, 
  useCreateProject, 
  useDeleteProject,
  useGetSubscription,
  getListProjectsQueryKey,
  getGetDashboardStatsQueryKey,
  getGetSubscriptionQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { 
  Video, Plus, Clock, PlayCircle, CheckCircle2, 
  Trash2, AlertCircle, Loader2, Sparkles, Activity, TrendingUp
} from "lucide-react";
import { BackButton } from "@/components/back-button";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { deleteProjectVideos, usePlayableVideo } from "@/lib/video-storage";
import { ToastAction } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";

/**
 * A project's poster frame. The bucket is private, so the stored key has to be
 * signed before it can be shown — and each card signs its own rather than the
 * dashboard signing all of them, so one failure costs one card.
 */
function ProjectThumbnail({ project }: { project: { title: string; thumbnailPath?: string | null; thumbnailUrl?: string | null } }) {
  const { url } = usePlayableVideo(project.thumbnailPath ?? project.thumbnailUrl);
  if (!url) return <Video className="w-10 h-10 text-muted-foreground/30" />;
  return (
    <img
      src={url}
      alt={project.title}
      loading="lazy"
      className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity group-hover:scale-105 duration-500"
      data-testid="img-project-thumbnail"
    />
  );
}

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");

  const { data: stats, isLoading: isStatsLoading } = useGetDashboardStats({
    query: { queryKey: getGetDashboardStatsQueryKey() }
  });

  const { data: projects, isLoading: isProjectsLoading } = useListProjects({
    query: { queryKey: getListProjectsQueryKey() }
  });

  const { data: subscription, isLoading: isSubscriptionLoading } = useGetSubscription({
    query: { queryKey: getGetSubscriptionQueryKey() }
  });

  const createProject = useCreateProject();
  const deleteProject = useDeleteProject();
  const { user } = useAuth();

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    try {
      const project = await createProject.mutateAsync({ data: { title: newTitle } });
      queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetSubscriptionQueryKey() });
      setIsCreateOpen(false);
      setNewTitle("");
      setLocation(`/project/${project.id}`);
    } catch (error: unknown) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 429) {
        toast({
          title: "Video limit reached",
          description: `You've used all ${subscription?.videoLimitPerMonth ?? ""} videos on your ${subscription?.plan ?? ""} plan this month.`,
          variant: "destructive",
          action: (
            <ToastAction altText="Upgrade plan" onClick={() => window.location.href = "/#pricing"}>
              Upgrade
            </ToastAction>
          ),
        });
        setIsCreateOpen(false);
      } else {
        toast({
          title: "Failed to create project",
          description: "Please try again later.",
          variant: "destructive"
        });
      }
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      // Drop the stored bytes first: once the row is gone we no longer know
      // that this project existed, and the objects would linger unreferenced.
      if (user) await deleteProjectVideos(user.id, id);
      await deleteProject.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
      toast({
        title: "Project deleted",
        description: "The project has been removed."
      });
    } catch (error) {
      toast({
        title: "Failed to delete project",
        description: "Please try again later.",
        variant: "destructive"
      });
    }
  };

  /**
   * The badge, with one addition: a render nobody has picked up.
   *
   * "Processing" with a pulsing spark says work is happening. When the queue has
   * been unclaimed for five minutes there is no worker, and two of these have
   * been saying "Processing" for two days. The card should say which it is —
   * the state is not the user's fault and there is nothing for them to do about
   * it, but a lie about it is still a lie.
   */
  const getStatusBadge = (status: string, renderStalled = false) => {
    if (renderStalled) {
      return (
        <Badge
          variant="outline"
          className="bg-amber-500/10 text-amber-400 border-amber-500/20"
          title="The render is queued, but no machine has picked it up."
          data-testid="badge-render-stalled"
        >
          <Clock className="w-3 h-3 mr-1" /> Waiting for a machine
        </Badge>
      );
    }
    switch (status) {
      case 'uploading':
        return <Badge variant="outline" className="bg-blue-500/10 text-blue-500 border-blue-500/20"><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Uploading</Badge>;
      case 'ready':
        return <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20"><PlayCircle className="w-3 h-3 mr-1" /> Ready</Badge>;
      case 'processing':
        return <Badge variant="outline" className="bg-secondary/10 text-secondary border-secondary/20"><Sparkles className="w-3 h-3 mr-1 animate-pulse" /> Processing</Badge>;
      case 'done':
        return <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/20"><CheckCircle2 className="w-3 h-3 mr-1" /> Done</Badge>;
      case 'failed':
        return <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20"><AlertCircle className="w-3 h-3 mr-1" /> Failed</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="w-full max-w-7xl mx-auto px-6 py-12">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-12 gap-4">
        <div className="flex items-start gap-2">
          <BackButton fallback="/" className="-ml-3 mt-1" />
          <div>
          <h1 className="text-3xl font-bold tracking-tight glow-text mb-2">Projects</h1>
          <p className="text-muted-foreground">Manage your AI video edits and exports.</p>
          </div>
        </div>
        <Button 
          onClick={() => setIsCreateOpen(true)}
          className="glow-btn rounded-full bg-primary text-primary-foreground hover:bg-primary/90 px-6 h-12"
          data-testid="button-new-project"
        >
          <Plus className="w-5 h-5 mr-2" />
          New Project
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
        <Card className="glass-panel border-white/5">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Projects</CardTitle>
            <Video className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            {isStatsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-3xl font-bold">{stats?.totalProjects || 0}</div>
            )}
          </CardContent>
        </Card>
        <Card className="glass-panel border-white/5">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Currently Processing</CardTitle>
            <Activity className="w-4 h-4 text-secondary" />
          </CardHeader>
          <CardContent>
            {isStatsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-3xl font-bold">{stats?.processingCount || 0}</div>
            )}
          </CardContent>
        </Card>
        <Card className="glass-panel border-white/5">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Completed Edits</CardTitle>
            <CheckCircle2 className="w-4 h-4 text-green-500" />
          </CardHeader>
          <CardContent>
            {isStatsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-3xl font-bold">{stats?.doneCount || 0}</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Usage Banner */}
      {!isSubscriptionLoading && subscription && (
        <div className={`mb-8 rounded-2xl border px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 glass-panel ${
          subscription.videosUsedThisMonth >= subscription.videoLimitPerMonth
            ? "border-red-500/30 bg-red-500/5"
            : subscription.videosUsedThisMonth / subscription.videoLimitPerMonth >= 0.8
            ? "border-amber-500/30 bg-amber-500/5"
            : "border-white/5"
        }`}>
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
              subscription.videosUsedThisMonth >= subscription.videoLimitPerMonth
                ? "bg-red-500/15"
                : subscription.videosUsedThisMonth / subscription.videoLimitPerMonth >= 0.8
                ? "bg-amber-500/15"
                : "bg-primary/10"
            }`}>
              <TrendingUp className={`w-4 h-4 ${
                subscription.videosUsedThisMonth >= subscription.videoLimitPerMonth
                  ? "text-red-400"
                  : subscription.videosUsedThisMonth / subscription.videoLimitPerMonth >= 0.8
                  ? "text-amber-400"
                  : "text-primary"
              }`} />
            </div>
            <div>
              <div className="text-sm font-medium">
                <span className="font-bold">{subscription.videosUsedThisMonth} / {subscription.videoLimitPerMonth}</span>
                {" "}videos used this month
              </div>
              <div className="mt-1.5 w-48 h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    subscription.videosUsedThisMonth >= subscription.videoLimitPerMonth
                      ? "bg-red-400"
                      : subscription.videosUsedThisMonth / subscription.videoLimitPerMonth >= 0.8
                      ? "bg-amber-400"
                      : "bg-primary"
                  }`}
                  style={{ width: `${Math.min(100, (subscription.videosUsedThisMonth / subscription.videoLimitPerMonth) * 100)}%` }}
                />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="outline" className="capitalize border-white/10 bg-white/5 text-xs font-semibold">
              {subscription.plan} plan
            </Badge>
            {subscription.videosUsedThisMonth / subscription.videoLimitPerMonth >= 0.8 && (
              <Link href="/#pricing">
                <Button size="sm" className="bg-primary hover:bg-primary/90 text-white rounded-full text-xs h-8 px-4">
                  Upgrade
                </Button>
              </Link>
            )}
          </div>
        </div>
      )}

      {/* Projects Grid */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Recent Projects</h2>
        
        {isProjectsLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3].map(i => (
              <Card key={i} className="glass-panel overflow-hidden border-white/5">
                <Skeleton className="w-full aspect-[16/9] rounded-none" />
                <CardContent className="p-4">
                  <Skeleton className="h-5 w-2/3 mb-2" />
                  <Skeleton className="h-4 w-1/3" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : projects?.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center glass-panel rounded-2xl border-white/5 border-dashed">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4 border border-primary/20">
              <Video className="w-8 h-8 text-primary" />
            </div>
            <h3 className="text-xl font-bold mb-2">No projects yet</h3>
            <p className="text-muted-foreground max-w-sm mb-6">Create your first project to start turning raw videos into viral content.</p>
            <Button onClick={() => setIsCreateOpen(true)} variant="outline" className="rounded-full">
              Create Project
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects?.map(project => (
              <Link key={project.id} href={`/project/${project.id}`}>
                <Card className="glass-panel border-white/5 overflow-hidden hover:border-primary/50 transition-colors group cursor-pointer h-full flex flex-col">
                  <div className="w-full aspect-[16/9] bg-black/60 relative overflow-hidden flex-shrink-0">
                    {project.thumbnailPath || project.thumbnailUrl ? (
                      <ProjectThumbnail project={project} />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Video className="w-10 h-10 text-white/20" />
                      </div>
                    )}
                    <div className="absolute top-3 right-3">
                      {getStatusBadge(project.status, project.renderStalled)}
                    </div>
                  </div>
                  <CardContent className="p-5 flex-1">
                    <CardTitle className="text-lg mb-1 group-hover:text-primary transition-colors line-clamp-1" data-testid={`text-project-title-${project.id}`}>
                      {project.title}
                    </CardTitle>
                    <div className="flex items-center text-xs text-muted-foreground">
                      <Clock className="w-3 h-3 mr-1" />
                      {format(new Date(project.updatedAt), 'MMM d, yyyy')}
                    </div>
                  </CardContent>
                  <CardFooter className="p-4 pt-0 flex justify-end">
                    <Button 
                      variant="ghost" 
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      onClick={(e) => handleDelete(project.id, e)}
                      data-testid={`button-delete-${project.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </CardFooter>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>

      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="glass-panel border-white/10 sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Create New Project</DialogTitle>
            <DialogDescription>
              Give your project a name to get started.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="flex flex-col gap-3">
              <Label htmlFor="name" className="text-left">
                Project Name
              </Label>
              <Input
                id="name"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="e.g. My Viral Short"
                className="col-span-3 bg-white/5 border-white/10 focus-visible:ring-primary"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsCreateOpen(false)}>Cancel</Button>
            <Button 
              onClick={handleCreate} 
              disabled={!newTitle.trim() || createProject.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              data-testid="button-submit-project"
            >
              {createProject.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Create Project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
