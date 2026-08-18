import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  facetDesignEvidenceResponseSchema,
  type FacetDesignEvidenceResponse,
} from "./facet-design-contracts";

export async function loadFacetDesignEvidence(
  fetcher: typeof fetch = fetch,
): Promise<FacetDesignEvidenceResponse> {
  return await apiRequest({
    path: API_PATHS.facetDesignEvidence,
    schema: facetDesignEvidenceResponseSchema,
    fetcher,
  });
}
