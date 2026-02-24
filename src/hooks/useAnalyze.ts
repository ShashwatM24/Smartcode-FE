import { useState, useEffect, useCallback, useRef } from 'react';
import { githubService } from '@/services/githubService';
import { complexityScoreToLabel, getLanguageColor } from '@/utils';
import type { AnalysisObject, AnalysisResult } from '@/types';
import { fetchRepoAnalysis } from '@/services/githubApiService';

const POLL_INTERVAL_MS = 2_000;
const TIMEOUT_MS = 120_000;

/** Errors that indicate the backend is simply not running */
const isNetworkError = (msg: string) =>
    msg.includes('network') ||
    msg.includes('econnrefused') ||
    msg.includes('failed to fetch') ||
    msg.includes('net::err') ||
    msg.includes('networkerror') ||
    msg.includes('load failed');

export type UseAnalyzeState =
    | { phase: 'idle' }
    | { phase: 'starting' }
    | { phase: 'polling' }
    | { phase: 'completed'; result: AnalysisResult }
    | { phase: 'error'; message: string };

/** Maps raw API AnalysisObject → internal AnalysisResult used by components */
function mapToResult(data: AnalysisObject): AnalysisResult {
    const label = complexityScoreToLabel(data.project.complexity_score);
    return {
        projectName: data.project.name,
        projectOwner: data.project.owner,
        projectType: data.project.project_type,
        techStack: data.project.tech_stack,
        complexityScore: data.project.complexity_score,
        complexityLabel: label,
        summary: data.summary,
        keyFeatures: data.key_features,
        fileTree: data.file_tree,
        languages: data.languages.map((l, i) => ({
            ...l,
            color: getLanguageColor(l.name, i),
        })),
        commits: data.commits,
        architectureDiagram: data.architecture_diagram,
    };
}



export function useAnalyze(repo: string | null): UseAnalyzeState {
    const [state, setState] = useState<UseAnalyzeState>({ phase: 'idle' });
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const startedRef = useRef(false);

    const clearTimers = useCallback(() => {
        if (pollRef.current) clearInterval(pollRef.current);
        if (timerRef.current) clearTimeout(timerRef.current);
    }, []);

    const startAnalysis = useCallback(async () => {
        if (!repo || startedRef.current) return;
        startedRef.current = true;
        setState({ phase: 'starting' });

        try {
            await githubService.analyze(repo);
        } catch (err) {
            const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

            // ── Offline mode: call GitHub API directly ────────────────────────
            if (isNetworkError(msg) && repo) {
                try {
                    const result = await fetchRepoAnalysis(repo);
                    setState({ phase: 'completed', result });
                } catch (ghErr) {
                    setState({ phase: 'error', message: ghErr instanceof Error ? ghErr.message : 'GitHub API fetch failed' });
                }
                return;
            }

            setState({ phase: 'error', message: err instanceof Error ? err.message : 'Failed to start analysis' });
            return;
        }

        setState({ phase: 'polling' });

        // Timeout guard
        timerRef.current = setTimeout(() => {
            clearTimers();
            setState({ phase: 'error', message: 'Analysis timed out. Please try again.' });
        }, TIMEOUT_MS);

        // Poll every 2 seconds
        pollRef.current = setInterval(async () => {
            try {
                const response = await githubService.getStatus(repo);

                if (response.status === 'complete') {
                    clearTimers();
                    if (response.data) {
                        setState({ phase: 'completed', result: mapToResult(response.data) });
                    } else {
                        setState({ phase: 'error', message: 'Analysis complete but no data returned.' });
                    }
                } else if (response.status === 'failed') {
                    clearTimers();
                    setState({
                        phase: 'error',
                        message: response.error ?? 'Repository analysis failed.',
                    });
                }
                // status === 'processing' → stay in polling, do nothing
            } catch (err) {
                clearTimers();
                // If polling also fails with network error, fall back to GitHub API
                const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
                if (isNetworkError(msg) && repo) {
                    try {
                        const result = await fetchRepoAnalysis(repo);
                        setState({ phase: 'completed', result });
                    } catch {
                        setState({ phase: 'error', message: 'Cannot reach backend or GitHub API.' });
                    }
                } else {
                    setState({ phase: 'error', message: err instanceof Error ? err.message : 'Polling error' });
                }
            }
        }, POLL_INTERVAL_MS);

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [repo, clearTimers]);

    useEffect(() => {
        if (repo) {
            void startAnalysis();
        }
        return clearTimers;
    }, [repo, startAnalysis, clearTimers]);

    return state;
}
