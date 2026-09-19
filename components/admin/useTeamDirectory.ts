import { useQuery } from "@tanstack/react-query";
import { adminListUsers } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

export function useTeamDirectory() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["team-directory", user?.uid],
    queryFn: () => adminListUsers(500),
    enabled: Boolean(user?.uid),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
