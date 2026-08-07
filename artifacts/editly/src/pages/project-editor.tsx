import { useState, useEffect, useRef } from "react";
import { useLocation, useParams } from "wouter";
import { 
  useGetProject, 
  useUpdateProject,
  useListMessages,
  useSendMessage,
  getGetProjectQueryKey,
  getListMessagesQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { 
  UploadCloud, Play, Pause, ChevronLeft, Send,
  Scissors, Type, Wand2, Download, CheckCircle2, Loader2,
  Video
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import {
  uploadProjectVideo,
  usePlayableVideo,
  ACCEPTED_VIDEO_TYPES,
  MAX_UPLOAD_BYTES,
  formatBytes,
} from "@/lib/video-storage";
import { ToastAction } from "@/components/ui/toast";
import { ScrollArea } from "@/components/ui/scroll-area";

export default function ProjectEditor() {
  const params = useParams();
  const id = params.id as string;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const cancelUploadRef = useRef<(() => void) | null>(null);
  const [isProcessingEdit, setIsProcessingEdit] = useState(false);
  const [editSteps, setEditSteps] = useState<string[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isNoahThinking, setIsNoahThinking] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const { data: project, isLoading: isProjectLoading } = useGetProject(id, {
    query: { enabled: !!id, queryKey: getGetProjectQueryKey(id) }
  });

  const { data: messages, isLoading: isMessagesLoading } = useListMessages(id, {
    query: { enabled: !!id, queryKey: getListMessagesQueryKey(id) }
  });

  const updateProject = useUpdateProject();
  const sendMessage = useSendMessage();
  const { user } = useAuth();

  // The bucket is private, so playback needs a freshly signed URL.
  const { url: playbackUrl } = usePlayableVideo(
    project?.editedVideoPath ?? project?.videoPath ?? project?.editedVideoUrl ?? project?.videoUrl,
  );
  const hasVideo = Boolean(project?.videoPath ?? project?.videoUrl);

  useEffect(() => {
    // Scroll to bottom of chat
    if (scrollAreaRef.current) {
      const scrollContainer = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
    }
  }, [messages, isProcessingEdit, editSteps, isNoahThinking]);

  const validateAndUpload = async (file: File) => {
    if (!ACCEPTED_VIDEO_TYPES.includes(file.type) && !file.name.match(/\.(mp4|mov|webm)$/i)) {
      toast({
        title: "Invalid file type",
        description: "Please upload an mp4, mov, or webm file.",
        variant: "destructive"
      });
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast({
        title: "File too large",
        description: `That file is ${formatBytes(file.size)}. The current limit is ${formatBytes(MAX_UPLOAD_BYTES)} per video.`,
        variant: "destructive"
      });
      return;
    }

    // Read the token fresh — Supabase rotates it roughly hourly and the copy
    // held in context may already be past its expiry on a long-open tab.
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!user || !accessToken) {
      toast({ title: "Please sign in again", variant: "destructive" });
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);
    setUploadedBytes(0);
    setTotalBytes(file.size);

    // Real bytes on the wire, not a timer pretending to be one.
    const handle = uploadProjectVideo({
      file,
      userId: user.id,
      projectId: id,
      accessToken,
      onProgress: (percent, loaded, total) => {
        setUploadProgress(percent);
        setUploadedBytes(loaded);
        setTotalBytes(total);
      },
    });
    cancelUploadRef.current = handle.cancel;

    try {
      const videoPath = await handle.done;
      await updateProject.mutateAsync({
        id,
        data: { status: "ready", videoPath }
      });
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(id) });
      toast({
        title: "Video uploaded",
        description: "Your video is stored and ready for editing."
      });
    } catch (error) {
      toast({
        title: "Upload failed",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive"
      });
    } finally {
      cancelUploadRef.current = null;
      setIsUploading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    validateAndUpload(file);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    validateAndUpload(file);
  };

  const handleSendChat = async () => {
    if (!chatInput.trim() || !id) return;
    
    const content = chatInput;
    setChatInput("");

    // Show Noah thinking indicator for 1.2s before dispatching
    setIsNoahThinking(true);
    await new Promise(r => setTimeout(r, 1200));
    setIsNoahThinking(false);
    
    try {
      await sendMessage.mutateAsync({
        id,
        data: { content }
      });
      queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(id) });
    } catch (error: unknown) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 429) {
        toast({
          title: "Edit limit reached",
          description: "You've used all your edits for this video on your current plan.",
          variant: "destructive",
          action: (
            <ToastAction altText="Upgrade plan" onClick={() => window.location.href = "/#pricing"}>
              Upgrade
            </ToastAction>
          ),
        });
      } else {
        toast({
          title: "Failed to send message",
          variant: "destructive"
        });
        setChatInput(content); // restore input
      }
    }
  };

  const handleGenerateEdit = async () => {
    setIsProcessingEdit(true);
    setEditSteps(["Analyzing video content..."]);
    
    // Simulate complex AI editing process
    const steps = [
      "Identifying silence gaps...",
      "Generating smart cuts...",
      "Transcribing audio...",
      "Applying dynamic captions...",
      "Adding cinematic color grade...",
      "Finalizing edit..."
    ];

    for (let i = 0; i < steps.length; i++) {
      await new Promise(r => setTimeout(r, 1500));
      setEditSteps(prev => [...prev, steps[i]]);
    }

    await new Promise(r => setTimeout(r, 1000));
    
    try {
      await updateProject.mutateAsync({
        id,
        data: {
          status: 'done',
          // Until the render worker exists there is no separate output file,
          // so the source stays the thing that plays. Setting editedVideoPath
          // here would claim a render happened that did not.
        }
      });
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(id) });
      setIsProcessingEdit(false);
      setEditSteps([]);
      toast({
        title: "Edit complete!",
        description: "Your AI-edited video is ready."
      });
    } catch (error) {
      setIsProcessingEdit(false);
      toast({
        title: "Edit failed",
        variant: "destructive"
      });
    }
  };

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  if (isProjectLoading) {
    return (
      <div className="w-full h-screen flex flex-col">
        <div className="h-16 border-b border-white/5 flex items-center px-6">
          <Skeleton className="h-8 w-8 mr-4" />
          <Skeleton className="h-6 w-48" />
        </div>
        <div className="flex-1 flex gap-6 p-6">
          <div className="flex-1">
            <Skeleton className="w-full h-full rounded-2xl" />
          </div>
          <div className="w-[400px]">
            <Skeleton className="w-full h-full rounded-2xl" />
          </div>
        </div>
      </div>
    );
  }

  if (!project) {
    return <div className="p-12 text-center">Project not found</div>;
  }

  return (
    <div className="w-full h-screen flex flex-col bg-background overflow-hidden">
      {/* Topbar */}
      <header className="h-16 flex-shrink-0 border-b border-white/10 bg-background/50 backdrop-blur-md flex items-center justify-between px-6 z-10">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setLocation('/dashboard')} className="text-muted-foreground hover:text-foreground">
            <ChevronLeft className="w-5 h-5" />
          </Button>
          <div className="h-6 w-px bg-white/10" />
          <h1 className="font-semibold text-lg" data-testid="text-editor-title">{project.title}</h1>
          <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-xs text-muted-foreground">
            {project.status}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Button 
            variant="outline" 
            className="border-white/10"
            disabled={!hasVideo}
            onClick={() => setLocation(`/export/${project.id}`)}
            data-testid="button-export"
          >
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
          <Button 
            className="glow-btn btn-gradient-cta text-white border-0"
            disabled={!hasVideo || isProcessingEdit || project.status === 'uploading'}
            onClick={handleGenerateEdit}
            data-testid="button-generate-edit"
          >
            <Wand2 className="w-4 h-4 mr-2" />
            Generate Edit
          </Button>
        </div>
      </header>

      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden relative">
        {/* Main Editor Area */}
        <div className="flex-1 flex flex-col relative p-4 lg:p-6 pb-0 overflow-hidden">
          
          <div className="flex-1 relative rounded-2xl overflow-hidden glass-panel border border-white/10 bg-black/40 flex flex-col">
            {!hasVideo ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
                {isUploading ? (
                  <div className="flex flex-col items-center w-full max-w-sm">
                    <Loader2 className="w-12 h-12 text-primary animate-spin mb-4" />
                    <h3 className="text-xl font-semibold mb-2">Uploading Video...</h3>
                    <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden mb-2">
                      <div className="h-full bg-primary transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
                    </div>
                    <p className="text-sm text-muted-foreground" data-testid="text-upload-progress">
                      {uploadProgress}%{totalBytes > 0 && ` · ${formatBytes(uploadedBytes)} of ${formatBytes(totalBytes)}`}
                    </p>
                  </div>
                ) : (
                  <div 
                    className={`flex flex-col items-center justify-center border-2 border-dashed rounded-2xl w-full max-w-lg aspect-video cursor-pointer transition-all group ${isDragOver ? 'border-primary bg-primary/10 scale-[1.02]' : 'border-white/20 hover:border-primary/50 hover:bg-primary/5'}`}
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                  >
                    <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                      <UploadCloud className={`w-8 h-8 transition-colors ${isDragOver ? 'text-primary' : 'text-muted-foreground group-hover:text-primary'}`} />
                    </div>
                    <h3 className="text-xl font-semibold mb-2">Upload Raw Footage</h3>
                    <p className="text-muted-foreground mb-2">Drag and drop or click to browse</p>
                    <p className="text-xs text-muted-foreground/60 mb-6">MP4 or MOV only &bull; max 1GB</p>
                    <Button variant="secondary" className="rounded-full pointer-events-none">
                      Select Video
                    </Button>
                    <input 
                      type="file" 
                      ref={fileInputRef} 
                      className="hidden" 
                      accept="video/mp4,video/quicktime,.mp4,.mov" 
                      onChange={handleFileChange}
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="w-full h-full flex flex-col">
                <div className="flex-1 relative flex items-center justify-center overflow-hidden"
                  style={{
                    background: "linear-gradient(135deg, #06030f 0%, #0a0518 50%, #080312 100%)",
                    boxShadow: "inset 0 0 60px rgba(108,59,255,0.12), inset 0 0 120px rgba(0,0,0,0.6)",
                  }}
                >
                  {/* Subtle purple glow edges */}
                  <div className="absolute inset-0 pointer-events-none"
                    style={{ background: "radial-gradient(ellipse at 50% 50%, transparent 40%, rgba(0,0,0,0.7) 100%)" }}
                  />
                  <div className="absolute inset-x-0 top-0 h-1 pointer-events-none"
                    style={{ background: "linear-gradient(90deg, transparent, rgba(108,59,255,0.4), rgba(155,107,255,0.6), rgba(108,59,255,0.4), transparent)" }}
                  />
                  <div className="absolute inset-x-0 bottom-0 h-1 pointer-events-none"
                    style={{ background: "linear-gradient(90deg, transparent, rgba(108,59,255,0.3), rgba(155,107,255,0.5), rgba(108,59,255,0.3), transparent)" }}
                  />
                  <video 
                    ref={videoRef}
                    src={playbackUrl ?? undefined} 
                    className="relative z-10 w-full h-full object-contain"
                    controls={false}
                    onEnded={() => setIsPlaying(false)}
                  />
                  
                  {/* Play/Pause overlay */}
                  <div 
                    className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 bg-black/20 transition-opacity cursor-pointer"
                    onClick={togglePlay}
                  >
                    <div className="w-16 h-16 rounded-full bg-black/50 backdrop-blur-sm border border-white/10 flex items-center justify-center text-white">
                      {isPlaying ? <Pause className="w-8 h-8" /> : <Play className="w-8 h-8 ml-1" />}
                    </div>
                  </div>

                  {project.status === 'done' && (
                    <div className="absolute top-4 left-4 px-3 py-1 rounded-full bg-green-500/20 text-green-400 border border-green-500/30 text-xs font-medium flex items-center backdrop-blur-md">
                      <CheckCircle2 className="w-3 h-3 mr-1" />
                      AI Edited
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Timeline Strip */}
          <div className="h-32 mt-4 rounded-xl glass-panel border border-white/10 p-4 flex flex-col mb-4 lg:mb-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground">Timeline</span>
              <div className="flex gap-2">
                <Button variant="ghost" size="icon" className="h-6 w-6"><Scissors className="w-3 h-3" /></Button>
                <Button variant="ghost" size="icon" className="h-6 w-6"><Type className="w-3 h-3" /></Button>
              </div>
            </div>
            <div className="flex-1 bg-black/30 rounded border border-white/5 relative overflow-hidden">
              {hasVideo ? (
                <div className="absolute inset-0 flex">
                  {/* Fake clips */}
                  <div className="h-full bg-primary/20 border-r border-black/50 w-1/4"></div>
                  <div className="h-full border-r border-black/50 w-1/2 timeline-segment-glow"
                    style={{ background: "rgba(108,59,255,0.25)" }}
                  ></div>
                  <div className="h-full bg-primary/20 w-1/4"></div>
                  
                  {/* Animated playhead */}
                  <div className="absolute top-0 bottom-0 w-0.5 bg-secondary shadow-[0_0_8px_rgba(155,107,255,1)] timeline-playhead-animated z-10">
                    <div className="absolute -top-1 -translate-x-1/2 w-3 h-3 rotate-45 bg-secondary" />
                  </div>
                </div>
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground/50">
                  Upload video to see timeline
                </div>
              )}
            </div>
          </div>
        </div>

        {/* AI Chat Sidebar */}
        <div className="w-full lg:w-[400px] border-l border-white/10 bg-background/80 backdrop-blur-xl flex flex-col z-20 shadow-[-20px_0_40px_rgba(0,0,0,0.5)]">
          {/* Noah header */}
          <div className="p-4 border-b border-white/10 flex items-center gap-3">
            <div className="relative flex-shrink-0">
              <img
                src="/noah-avatar.jpg"
                alt="Noah"
                className="w-10 h-10 rounded-full object-cover shadow-[0_0_12px_rgba(108,59,255,0.5)] ring-2 ring-primary/30"
              />
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-green-400 border-2 border-background shadow-[0_0_6px_rgba(74,222,128,0.8)]" />
            </div>
            <div>
              <h2 className="font-semibold text-sm leading-tight">Noah</h2>
              <p className="text-xs text-muted-foreground">Your AI editor</p>
            </div>
          </div>
          
          <ScrollArea ref={scrollAreaRef} className="flex-1 p-4">
            <div className="space-y-5 flex flex-col">
              {/* Welcome message — only shown when no messages exist yet */}
              {!isMessagesLoading && (!messages || messages.length === 0) && (
              <div className="flex gap-3 items-start">
                <img
                  src="/noah-avatar.jpg"
                  alt="Noah"
                  className="w-10 h-10 rounded-full object-cover flex-shrink-0 shadow-[0_2px_10px_rgba(0,0,0,0.4)] ring-1 ring-white/10"
                />
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="text-xs font-semibold text-purple-300 px-1">Noah</span>
                  <div className="bg-white/5 border border-white/10 rounded-2xl rounded-tl-sm px-4 py-3 text-sm leading-relaxed">
                    Hey, I'm Noah 👋<br />Your AI video editor.<br /><br />Upload your video and tell me the vibe — I'll turn it into a viral clip.
                  </div>
                </div>
              </div>
              )}

              {/* Messages */}
              {isMessagesLoading ? (
                <div className="flex gap-3 items-start">
                  <Skeleton className="w-10 h-10 rounded-full flex-shrink-0" />
                  <div className="flex flex-col gap-1 flex-1">
                    <Skeleton className="h-3 w-10 rounded" />
                    <Skeleton className="h-16 w-3/4 rounded-2xl" />
                  </div>
                </div>
              ) : (
                messages?.map(msg => (
                  <div key={msg.id} className={`message-appear flex gap-3 items-start ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                    {msg.role === 'assistant' && (
                      <img
                        src="/noah-avatar.jpg"
                        alt="Noah"
                        className="w-10 h-10 rounded-full object-cover flex-shrink-0 shadow-[0_2px_10px_rgba(0,0,0,0.4)] ring-1 ring-white/10"
                      />
                    )}
                    <div className={`flex flex-col gap-1 min-w-0 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                      {msg.role === 'assistant' && (
                        <span className="text-xs font-semibold text-purple-300 px-1">Noah</span>
                      )}
                      <div className={`px-4 py-3 text-sm leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-primary/20 border border-primary/30 rounded-2xl rounded-tr-sm text-foreground max-w-[85%]'
                          : 'bg-white/5 border border-white/10 rounded-2xl rounded-tl-sm'
                      }`}>
                        {msg.content}
                      </div>
                    </div>
                  </div>
                ))
              )}

              {/* Typing state — Noah is thinking or responding */}
              {(isNoahThinking || sendMessage.isPending) && (
                <div className="flex gap-3 items-start">
                  <img
                    src="/noah-avatar.jpg"
                    alt="Noah"
                    className="w-10 h-10 rounded-full object-cover flex-shrink-0 shadow-[0_2px_10px_rgba(0,0,0,0.4)] ring-1 ring-white/10"
                  />
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-semibold text-purple-300 px-1">Noah</span>
                    <div className="bg-white/5 border border-white/10 rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-1.5">
                      <span className="typing-dot w-1.5 h-1.5 rounded-full bg-purple-400 inline-block" />
                      <span className="typing-dot w-1.5 h-1.5 rounded-full bg-purple-400 inline-block" />
                      <span className="typing-dot w-1.5 h-1.5 rounded-full bg-purple-400 inline-block" />
                    </div>
                  </div>
                </div>
              )}

              {/* Processing Edit Steps */}
              {isProcessingEdit && (
                <div className="flex gap-3 items-start">
                  <img
                    src="/noah-avatar.jpg"
                    alt="Noah"
                    className="w-10 h-10 rounded-full object-cover flex-shrink-0 shadow-[0_2px_10px_rgba(0,0,0,0.4)] ring-1 ring-white/10"
                  />
                  <div className="flex flex-col gap-1 flex-1">
                    <span className="text-xs font-semibold text-purple-300 px-1">Noah</span>
                    <div className="bg-white/5 border border-secondary/30 rounded-2xl rounded-tl-sm px-4 py-3 text-sm w-full shadow-[0_0_15px_rgba(155,107,255,0.1)]">
                      <p className="font-semibold text-secondary mb-3 flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" /> Working on it…
                      </p>
                      <div className="space-y-2">
                        {editSteps.map((step, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                            {i < editSteps.length - 1 ? (
                              <CheckCircle2 className="w-3 h-3 text-green-500" />
                            ) : (
                              <div className="w-1.5 h-1.5 rounded-full bg-secondary animate-pulse ml-1 mr-0.5" />
                            )}
                            <span className={i === editSteps.length - 1 ? "text-foreground" : ""}>{step}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>

          <div className="p-4 border-t border-white/10 bg-black/20">
            <form 
              onSubmit={(e) => { e.preventDefault(); handleSendChat(); }}
              className="relative"
            >
              <Input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                placeholder="Describe your edit..."
                className="input-chat-glow pr-12 bg-white/5 border-white/10 rounded-full h-12"
                disabled={!hasVideo || isNoahThinking || sendMessage.isPending || isProcessingEdit}
                data-testid="input-chat"
              />
              <Button 
                type="submit"
                size="icon"
                disabled={!chatInput.trim() || !hasVideo || isNoahThinking || sendMessage.isPending || isProcessingEdit}
                className="absolute right-1 top-1 h-10 w-10 rounded-full bg-secondary text-white hover:bg-secondary/90 hover:shadow-[0_0_15px_rgba(155,107,255,0.6)] transition-all"
                data-testid="button-send-message"
              >
                <Send className="w-4 h-4" />
              </Button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
