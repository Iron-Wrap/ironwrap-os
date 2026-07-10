import { useEffect, useState } from "react";

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const setConnected = () => setOnline(true);
    const setDisconnected = () => setOnline(false);
    window.addEventListener("online", setConnected);
    window.addEventListener("offline", setDisconnected);
    return () => {
      window.removeEventListener("online", setConnected);
      window.removeEventListener("offline", setDisconnected);
    };
  }, []);
  return online;
}
