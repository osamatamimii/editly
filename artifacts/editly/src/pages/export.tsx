import { useState, useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { 
  useGetProject, 
  useStartExport,
  useGetExportStatus,
  getGetProjectQueryKey,
  getGetExportStatusQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, Download, Smartphone, PlaySquare, CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import { BackButton } from "@/components/back-button";
import { useToast } from "@/hooks/use-toast";
import { usePlayableVideo } from "@/lib/video-storage";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";

export default function ExportPage() {
  const params = useParams();
  const id = params.id as string;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [platform, setPlatform] = useState<"tiktok" | "reels" | "shorts">("tiktok");
  const [isExporting, setIsExporting] = useState(false);

  const { data: project, isLoading: isProjectLoading } = useGetProject(id, {
    query: { enabled: !!id, queryKey: getGetProjectQueryKey(id) }
  });

  // The bucket is private, so playback and download need a signed URL.
  const { url: playbackUrl } = usePlayableVideo(
    project?.editedVideoPath ?? project?.videoPath ?? project?.editedVideoUrl ?? project?.videoUrl,
  );
  const hasVideo = Boolean(project?.videoPath ?? project?.videoUrl);

  const { data: exportStatus } = useGetExportStatus(id, {
    query: { 
      enabled: isExporting,
      queryKey: getGetExportStatusQueryKey(id),
      refetchInterval: (query) => {
        // Stop polling if done or failed
        if (query.state.data?.status === 'done' || query.state.data?.status === 'failed') {
          return false;
        }
        return 2000;
      }
    }
  });

  const startExport = useStartExport();

  // Watch export status changes
  useEffect(() => {
    if (exportStatus) {
      if (exportStatus.status === 'done') {
        setIsExporting(false);
        toast({
          title: "Export Complete!",
          description: "Your video is ready to download."
        });
      } else if (exportStatus.status === 'failed') {
        setIsExporting(false);
        toast({
          title: "Export Failed",
          description: "Something went wrong. Please try again.",
          variant: "destructive"
        });
      }
    }
  }, [exportStatus, toast]);

  const handleStartExport = async () => {
    try {
      setIsExporting(true);
      await startExport.mutateAsync({
        id,
        data: { platform }
      });
      // Start polling
      queryClient.invalidateQueries({ queryKey: getGetExportStatusQueryKey(id) });
    } catch (error) {
      setIsExporting(false);
      toast({
        title: "Could not start export",
        variant: "destructive"
      });
    }
  };

  if (isProjectLoading) {
    return (
      <div className="w-full max-w-5xl mx-auto px-6 py-12">
        <Skeleton className="h-8 w-48 mb-8" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          <Skeleton className="aspect-[9/16] w-full rounded-2xl" />
          <div className="space-y-6">
            <Skeleton className="h-64 w-full rounded-2xl" />
            <Skeleton className="h-16 w-full rounded-2xl" />
          </div>
        </div>
      </div>
    );
  }

  if (!project) return <div className="p-12 text-center">Project not found</div>;

  const currentStatus = isExporting ? exportStatus?.status : (exportStatus?.status === 'done' ? 'done' : 'idle');

  return (
    <div className="w-full max-w-6xl mx-auto px-6 py-12 min-h-screen">
      <BackButton
        fallback={`/project/${project.id}`}
        label="Back"
        className="mb-8 -ml-4"
        testId="button-back-export"
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">
        {/* Preview Container */}
        <div className="lg:col-span-5 flex justify-center">
          <div className="w-full max-w-[360px] aspect-[9/16] bg-black rounded-3xl overflow-hidden glass-panel border-4 border-white/10 relative shadow-[0_0_50px_rgba(108,59,255,0.2)]">
            {playbackUrl ? (
              <video 
                src={playbackUrl} 
                className="w-full h-full object-cover"
                controls
                autoPlay
                loop
                muted
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground p-6 text-center">
                <AlertCircle className="w-8 h-8 mb-2" />
                <p>No video available to export</p>
              </div>
            )}
            
            {/* Fake Platform UI Overlay based on selection */}
            <div className="absolute right-4 bottom-24 flex flex-col gap-4 pointer-events-none opacity-80">
              <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur border border-white/30" />
              <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur border border-white/30" />
              <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur border border-white/30" />
            </div>
            <div className="absolute bottom-4 left-4 right-16 pointer-events-none opacity-80">
              <div className="w-32 h-4 bg-white/20 rounded mb-2" />
              <div className="w-48 h-3 bg-white/20 rounded" />
            </div>
          </div>
        </div>

        {/* Export Controls */}
        <div className="lg:col-span-7 flex flex-col gap-8">
          <div>
            <h1 className="text-4xl font-bold tracking-tight mb-2 glow-text">Export Project</h1>
            <p className="text-xl text-muted-foreground">{project.title}</p>
          </div>

          {currentStatus === 'idle' && (
            <>
              <Card className="glass-panel border-white/10">
                <CardHeader>
                  <CardTitle>Select Platform Format</CardTitle>
                  <CardDescription>
                    AI will optimize the framing and resolution for your chosen platform.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <RadioGroup value={platform} onValueChange={(v) => setPlatform(v as "tiktok" | "reels" | "shorts")} className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <RadioGroupItem value="tiktok" id="tiktok" className="peer sr-only" />
                      <Label
                        htmlFor="tiktok"
                        className="flex flex-col items-center justify-between rounded-xl border-2 border-white/10 bg-black/40 p-4 hover:bg-white/5 hover:text-accent-foreground peer-data-[state=checked]:border-primary peer-data-[state=checked]:bg-primary/10 [&:has([data-state=checked])]:border-primary cursor-pointer transition-all"
                      >
                        <Smartphone className="mb-3 h-8 w-8 text-[#00f2fe]" />
                        <span className="font-semibold text-lg">TikTok</span>
                        <span className="text-xs text-muted-foreground mt-1">9:16 Vertical</span>
                      </Label>
                    </div>
                    <div>
                      <RadioGroupItem value="reels" id="reels" className="peer sr-only" />
                      <Label
                        htmlFor="reels"
                        className="flex flex-col items-center justify-between rounded-xl border-2 border-white/10 bg-black/40 p-4 hover:bg-white/5 hover:text-accent-foreground peer-data-[state=checked]:border-secondary peer-data-[state=checked]:bg-secondary/10 [&:has([data-state=checked])]:border-secondary cursor-pointer transition-all"
                      >
                        <PlaySquare className="mb-3 h-8 w-8 text-[#E1306C]" />
                        <span className="font-semibold text-lg">Reels</span>
                        <span className="text-xs text-muted-foreground mt-1">9:16 Vertical</span>
                      </Label>
                    </div>
                    <div>
                      <RadioGroupItem value="shorts" id="shorts" className="peer sr-only" />
                      <Label
                        htmlFor="shorts"
                        className="flex flex-col items-center justify-between rounded-xl border-2 border-white/10 bg-black/40 p-4 hover:bg-white/5 hover:text-accent-foreground peer-data-[state=checked]:border-red-500 peer-data-[state=checked]:bg-red-500/10 [&:has([data-state=checked])]:border-red-500 cursor-pointer transition-all"
                      >
                        <PlaySquare className="mb-3 h-8 w-8 text-red-500" />
                        <span className="font-semibold text-lg">Shorts</span>
                        <span className="text-xs text-muted-foreground mt-1">9:16 Vertical</span>
                      </Label>
                    </div>
                  </RadioGroup>
                </CardContent>
              </Card>

              <Button 
                size="lg" 
                className="w-full h-16 text-lg font-bold rounded-xl glow-btn bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={handleStartExport}
                disabled={!hasVideo}
                data-testid="button-start-export"
              >
                Render & Export
              </Button>
            </>
          )}

          {isExporting && (
            <Card className="glass-panel border-primary/30 shadow-[0_0_30px_rgba(108,59,255,0.15)] relative overflow-hidden">
              <div className="absolute top-0 left-0 h-1 bg-primary animate-pulse w-full"></div>
              <CardHeader>
                <CardTitle className="flex items-center gap-3">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  Rendering Video
                </CardTitle>
                <CardDescription>
                  Applying final AI touches and formatting for {platform}.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {exportStatus?.steps.map((step, idx) => (
                  <div key={idx} className="flex items-center gap-4">
                    {step.status === 'done' ? (
                      <CheckCircle2 className="w-6 h-6 text-green-500 flex-shrink-0" />
                    ) : step.status === 'active' ? (
                      <Loader2 className="w-6 h-6 animate-spin text-secondary flex-shrink-0" />
                    ) : (
                      <div className="w-6 h-6 rounded-full border-2 border-white/20 flex-shrink-0" />
                    )}
                    <span className={`text-lg ${
                      step.status === 'active' ? 'text-white font-medium' : 
                      step.status === 'done' ? 'text-muted-foreground' : 'text-white/30'
                    }`}>
                      {step.label}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {currentStatus === 'done' && (
            <Card className="glass-panel border-green-500/30 shadow-[0_0_30px_rgba(34,197,94,0.15)]">
              <CardHeader className="text-center pb-2">
                <div className="mx-auto w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mb-4">
                  <CheckCircle2 className="w-8 h-8 text-green-500" />
                </div>
                <CardTitle className="text-2xl text-green-400">Ready to Share</CardTitle>
                <CardDescription>
                  Your video has been successfully optimized for {exportStatus?.platform || platform}.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-6">
                <Button 
                  size="lg" 
                  className="w-full h-16 text-lg font-bold rounded-xl bg-white text-black hover:bg-gray-200 transition-all shadow-[0_0_20px_rgba(255,255,255,0.3)]"
                  onClick={() => {
                    // Simulate download
                    const link = document.createElement('a');
                    link.href = exportStatus?.downloadUrl || playbackUrl || '#';
                    link.download = `${project.title.replace(/\s+/g, '-').toLowerCase()}-${platform}.mp4`;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    
                    toast({
                      title: "Download started",
                      description: "Your video is downloading."
                    });
                  }}
                  data-testid="button-download"
                >
                  <Download className="w-5 h-5 mr-3" />
                  Download Video
                </Button>
                
                <div className="mt-6 flex gap-4 justify-center">
                  <Button variant="outline" className="border-white/10" onClick={() => {
                    setIsExporting(false); // Reset to start another export
                    queryClient.invalidateQueries({ queryKey: getGetExportStatusQueryKey(id) });
                  }}>
                    Export Another Format
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
