import { useEffect, useState } from "react";

function displayModeIsStandalone(): boolean {
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    navigatorWithStandalone.standalone === true
  );
}

export function useInstallPrompt() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent>();
  const [installed, setInstalled] = useState(displayModeIsStandalone);

  useEffect(() => {
    const beforeInstall = (event: BeforeInstallPromptEvent) => {
      event.preventDefault();
      setPromptEvent(event);
    };
    const appInstalled = () => {
      setPromptEvent(undefined);
      setInstalled(true);
    };
    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", appInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      window.removeEventListener("appinstalled", appInstalled);
    };
  }, []);

  async function promptInstall(): Promise<boolean> {
    if (!promptEvent) return false;
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    if (choice.outcome === "accepted") setPromptEvent(undefined);
    return choice.outcome === "accepted";
  }

  return { canInstall: Boolean(promptEvent) && !installed, installed, promptInstall };
}
