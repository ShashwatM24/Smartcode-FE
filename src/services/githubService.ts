import apiClient from './apiClient';
import type { AnalysisObject, AnalyzeRequest, ApiResponse } from '@/types';

export const githubService = {
    /**
     * POST /analyze
     * Initiates analysis of a GitHub repository.
     * Returns the full API response envelope so the hook can inspect status.
     */
    async analyze(repo: string): Promise<ApiResponse<AnalysisObject | null>> {
        const body: AnalyzeRequest = { repo };
        const res = await apiClient.post<ApiResponse<AnalysisObject | null>>('/analyze', body);
        return res.data;
    },

    /**
     * GET /status?repo=owner/repo
     * Polls the current analysis status.
     * Returns the full API response envelope.
     */
    async getStatus(repo: string): Promise<ApiResponse<AnalysisObject | null>> {
        const res = await apiClient.get<ApiResponse<AnalysisObject | null>>('/status', {
            params: { repo },
        });
        return res.data;
    },
};
