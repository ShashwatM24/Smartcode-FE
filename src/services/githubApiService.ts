/**
 * githubApiService.ts
 *
 * Fetches real repository data directly from the GitHub public REST API.
 * No backend required — works for any public repository.
 * Unauthenticated: 60 req/hr · With VITE_GITHUB_TOKEN: 5,000 req/hr.
 * On 401 (bad/revoked token) it automatically retries without auth.
 */

import type { AnalysisResult, FileNode, CommitStat, MappedLanguageStat } from '@/types';
import { complexityScoreToLabel, getLanguageColor } from '@/utils';

const BASE = 'https://api.github.com';

// Read token once at startup; cleared at runtime if it proves invalid
let TOKEN: string | undefined = import.meta.env.VITE_GITHUB_TOKEN as string | undefined;

function authHeaders(withToken: boolean): HeadersInit {
    return withToken && TOKEN
        ? { Accept: 'application/vnd.github+json', Authorization: `Bearer ${TOKEN}` }
        : { Accept: 'application/vnd.github+json' };
}

async function ghFetch<T>(path: string): Promise<T> {
    const res = await fetch(`${BASE}${path}`, { headers: authHeaders(true) });

    // Bad / revoked token → clear it and retry without auth
    if (res.status === 401) {
        console.warn('[githubApiService] Token invalid — retrying unauthenticated.');
        TOKEN = undefined;
        const retry = await fetch(`${BASE}${path}`, { headers: authHeaders(false) });
        if (!retry.ok) {
            const body = await retry.json().catch(() => ({})) as { message?: string };
            throw new Error(body.message ?? `GitHub API error ${retry.status}`);
        }
        return retry.json() as Promise<T>;
    }

    if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(body.message ?? `GitHub API error ${res.status} for ${path}`);
    }
    return res.json() as Promise<T>;
}

// ── GitHub API shapes ─────────────────────────────────────────────────────────

interface GhRepo {
    name: string;
    owner: { login: string };
    description: string | null;
    language: string | null;
    stargazers_count: number;
    forks_count: number;
    open_issues_count: number;
    size: number;
    topics: string[];
    default_branch: string;
}

interface GhTreeItem { path: string; type: 'blob' | 'tree'; sha: string; }
interface GhTree { tree: GhTreeItem[]; truncated: boolean; }
interface GhCommit { commit: { committer: { date: string } | null }; }

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFileTree(items: GhTreeItem[], repoName: string): FileNode[] {
    const root: FileNode = { name: repoName, path: '', type: 'folder', children: [] };
    for (const item of items) {
        const parts = item.path.split('/');
        let cur = root;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLast = i === parts.length - 1;
            if (isLast) {
                cur.children!.push({ name: part, path: item.path, type: item.type === 'tree' ? 'folder' : 'file', children: item.type === 'tree' ? [] : undefined });
            } else {
                let folder = cur.children!.find((n) => n.name === part && n.type === 'folder');
                if (!folder) { folder = { name: part, path: parts.slice(0, i + 1).join('/'), type: 'folder', children: [] }; cur.children!.push(folder); }
                cur = folder;
            }
        }
    }
    return [root];
}

function aggregateCommits(commits: GhCommit[]): CommitStat[] {
    const counts: Record<string, number> = {};
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        counts[d.toLocaleString('en-US', { month: 'short' })] = 0;
    }
    for (const c of commits) {
        const date = c.commit.committer?.date;
        if (!date) continue;
        const label = new Date(date).toLocaleString('en-US', { month: 'short' });
        if (label in counts) counts[label]++;
    }
    return Object.entries(counts).map(([month, count]) => ({ month, count }));
}

function mapLanguages(raw: Record<string, number>): MappedLanguageStat[] {
    const entries = Object.entries(raw).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const total = entries.reduce((s, [, v]) => s + v, 0);
    if (total === 0) return [];

    // Largest-remainder method so percentages always sum to 100
    const floats = entries.map(([name, bytes]) => ({ name, exact: (bytes / total) * 100 }));
    const floors = floats.map((x) => ({ ...x, floor: Math.floor(x.exact), rem: x.exact - Math.floor(x.exact) }));
    let remainder = 100 - floors.reduce((s, x) => s + x.floor, 0);
    floors.sort((a, b) => b.rem - a.rem);
    floors.forEach((x) => { if (remainder > 0) { x.floor += 1; remainder--; } });

    return floors
        .filter((x) => x.floor > 0)
        .sort((a, b) => b.floor - a.floor)
        .map((x, i) => ({ name: x.name, percentage: x.floor, color: getLanguageColor(x.name, i) }));
}

function deriveComplexityScore(repo: GhRepo, fileCount: number): number {
    const s = Math.min(repo.size / 500, 4) + Math.min(fileCount / 200, 3) + Math.min(repo.stargazers_count / 1000, 2) + Math.min(repo.open_issues_count / 100, 1);
    return Math.round(s * 10) / 10;
}

function inferProjectType(repo: GhRepo): string {
    const t = repo.topics.map((x) => x.toLowerCase());
    const l = (repo.language ?? '').toLowerCase();
    if (t.some((x) => ['web', 'webapp', 'frontend', 'react', 'vue', 'angular', 'nextjs'].includes(x))) return 'Web Application';
    if (t.some((x) => ['api', 'backend', 'rest', 'graphql', 'microservice'].includes(x))) return 'Backend / API';
    if (t.some((x) => ['cli', 'tool', 'utility', 'script'].includes(x))) return 'CLI Tool';
    if (t.some((x) => ['library', 'framework', 'sdk', 'package'].includes(x))) return 'Library / Framework';
    if (t.some((x) => ['machine-learning', 'ml', 'deep-learning', 'ai', 'nlp'].includes(x))) return 'Machine Learning / AI';
    if (t.some((x) => ['mobile', 'android', 'ios', 'flutter', 'react-native'].includes(x))) return 'Mobile Application';
    if (['jupyter notebook', 'r'].includes(l)) return 'Data Science';
    return 'Software Project';
}

function inferTechStack(repo: GhRepo): string[] {
    const stack = new Set<string>();
    if (repo.language) stack.add(repo.language);
    for (const t of repo.topics) stack.add(t.charAt(0).toUpperCase() + t.slice(1));
    return [...stack].slice(0, 10);
}

// ── Architecture diagram (file-tree aware) ────────────────────────────────────

function buildArchDiagram(repo: GhRepo, languages: MappedLanguageStat[], filePaths: string[]): string {
    const topics = repo.topics.map((t) => t.toLowerCase());
    const lang = (repo.language ?? '').toLowerCase();
    const topLang = languages[0]?.name ?? repo.language ?? 'Code';
    const files = filePaths.map((f) => f.toLowerCase());

    const hasFile = (...kw: string[]) => files.some((f) => kw.some((k) => f.includes(k)));
    const hasTopic = (...kw: string[]) => kw.some((k) => topics.includes(k));

    // UI layer — also true for any server-side web framework
    const isReact = hasTopic('react', 'nextjs', 'gatsby') || hasFile('react', 'jsx', 'tsx', 'next.config');
    const isVue = hasTopic('vue', 'nuxt') || hasFile('vue', 'nuxt.config');
    const isAngular = hasTopic('angular') || hasFile('angular.json');
    const isSvelte = hasTopic('svelte') || hasFile('svelte');

    const uiLabel = isReact ? 'Browser (React UI)'
        : isVue ? 'Browser (Vue.js UI)'
            : isAngular ? 'Browser (Angular UI)'
                : isSvelte ? 'Browser (Svelte UI)'
                    : hasTopic('bootstrap') || hasFile('bootstrap') ? 'Browser (Bootstrap UI)'
                        : hasTopic('tailwind') || hasFile('tailwind') ? 'Browser (Tailwind UI)'
                            : `Browser (${topLang} UI)`;

    const isFlask = hasTopic('flask') || hasFile('flask', 'app.py', 'wsgi.py');
    const isDjango = hasTopic('django') || hasFile('manage.py', 'django', 'settings.py');
    const isFastAPI = hasTopic('fastapi') || hasFile('fastapi');
    const isExpress = hasTopic('express') || hasFile('express', 'server.js', 'server.ts', 'app.js');
    const isNestJS = hasTopic('nestjs') || hasFile('nest-cli.json', '.module.ts', '.controller.ts');
    const isSpring = hasTopic('spring') || hasFile('application.properties', 'pom.xml');
    const isRails = hasTopic('rails') || hasFile('gemfile', 'config/routes.rb');
    const isLaravel = hasTopic('laravel') || hasFile('artisan');
    const isNext = hasTopic('nextjs') || hasFile('next.config');

    // Web frameworks always render HTML to a browser — always show browser UI layer
    const isWebFramework = isFlask || isDjango || isFastAPI || isExpress || isNestJS || isSpring || isRails || isLaravel || isNext;
    const hasUI = isReact || isVue || isAngular || isSvelte || isWebFramework
        || hasTopic('frontend', 'web', 'webapp', 'html', 'bootstrap', 'tailwind')
        || hasFile('index.html', 'bootstrap', 'tailwind')
        || ['javascript', 'typescript', 'html', 'css'].includes(lang);

    const appLabel = isFlask ? 'Flask Application (app.py)'
        : isDjango ? 'Django Application (views.py)'
            : isFastAPI ? 'FastAPI Application (main.py)'
                : isNestJS ? 'NestJS Application (main.ts)'
                    : isExpress ? 'Express.js Server (server.js)'
                        : isSpring ? 'Spring Boot Application'
                            : isRails ? 'Ruby on Rails Application'
                                : isLaravel ? 'Laravel Application'
                                    : isNext ? 'Next.js Application'
                                        : `${topLang} Application`;

    // Sub-components (pick 3)
    const comps: Array<[string, string]> = [];
    const addC = (name: string, sub: string, ...cond: boolean[]) => { if (cond.some(Boolean) && comps.length < 5) comps.push([name, sub]); };
    addC('Auth', 'Routes', hasTopic('auth', 'authentication', 'jwt', 'oauth'), hasFile('auth', 'login', 'jwt', 'passport', 'session'));
    addC('User', 'Routes', hasTopic('user', 'profile', 'account', 'admin'), hasFile('user', 'profile', 'account', 'members'));
    addC('Product', 'Routes', hasTopic('product', 'inventory', 'item', 'stock'), hasFile('product', 'inventory', 'item', 'catalog'));
    addC('Bill', 'Routes', hasTopic('billing', 'bill', 'invoice', 'payment'), hasFile('bill', 'invoice', 'payment', 'order', 'stripe'));
    addC('API', 'Routes', hasTopic('api', 'rest', 'graphql'), hasFile('api/', 'routes/', 'controllers/', 'graphql'));
    addC('Analytics', 'Routes', hasTopic('analytics', 'dashboard', 'metrics'), hasFile('analytics', 'dashboard', 'metrics', 'charts'));
    addC('AI', 'Layer ', hasTopic('ai', 'ml', 'openai', 'gemini'), hasFile('openai', 'gemini', 'langchain', 'llm', 'embedding'));
    addC('WebSocket', 'Layer ', hasTopic('websocket', 'realtime', 'socket.io'), hasFile('socket.io', 'websocket', 'realtime'));
    if (comps.length < 2) comps.push(['Core', 'Logic ']);
    if (comps.length < 3) comps.push(['Utils', 'Layer ']);
    const [c1, c2, c3] = comps.slice(0, 3);

    // ORM
    const isSQLAlchemy = hasTopic('sqlalchemy') || hasFile('sqlalchemy', 'models.py');
    const isPrisma = hasTopic('prisma') || hasFile('schema.prisma', 'prisma/');
    const isSequelize = hasTopic('sequelize') || hasFile('sequelize', '.model.js', '.model.ts');
    const isMongoose = hasTopic('mongoose') || hasFile('mongoose', 'schema.js', 'schema.ts');
    const isTypeORM = hasTopic('typeorm') || hasFile('typeorm', '.entity.ts', 'ormconfig');
    const hasORM = isSQLAlchemy || isPrisma || isSequelize || isMongoose || isTypeORM || hasFile('models/', 'migrations/');
    const ormLabel = isSQLAlchemy ? 'SQLAlchemy ORM Layer'
        : isPrisma ? 'Prisma ORM Layer'
            : isSequelize ? 'Sequelize ORM Layer'
                : isMongoose ? 'Mongoose ODM Layer'
                    : isTypeORM ? 'TypeORM Layer'
                        : 'Data Access / ORM Layer';

    // DB
    const isSQLite = hasTopic('sqlite') || hasFile('.db', 'sqlite');
    const isPostgres = hasTopic('postgresql') || hasFile('postgres', 'pg');
    const isMySQL = hasTopic('mysql') || hasFile('mysql');
    const isMongoDB = hasTopic('mongodb') || hasFile('mongodb', 'mongo');
    const isRedis = hasTopic('redis') || hasFile('redis');
    const isSupabase = hasTopic('supabase') || hasFile('supabase');
    const isFirebase = hasTopic('firebase') || hasFile('firebase', 'firestore');
    const hasDB = isSQLite || isPostgres || isMySQL || isMongoDB || isRedis || isSupabase || isFirebase || hasORM || hasTopic('database', 'db', 'sql');
    const dbLabel = isSQLite ? 'SQLite Database'
        : isPostgres ? 'PostgreSQL Database'
            : isMySQL ? 'MySQL Database'
                : isMongoDB ? 'MongoDB Database'
                    : isRedis ? 'Redis Cache / Store'
                        : isSupabase ? 'Supabase (PostgreSQL)'
                            : isFirebase ? 'Firebase / Firestore'
                                : 'Database Layer';

    const entities: string[] = [];
    if (hasFile('user', 'auth', 'login', 'account')) entities.push('[users]');
    if (hasFile('product', 'inventory', 'item', 'catalog', 'stock')) entities.push('[products]');
    if (hasFile('bill', 'invoice', 'order', 'payment')) entities.push('[bills]');
    if (hasFile('categor', 'tag', 'genre')) entities.push('[categories]');
    if (hasFile('post', 'blog', 'article', 'comment')) entities.push('[posts]');
    if (hasFile('message', 'chat', 'conversation')) entities.push('[messages]');
    if (entities.length === 0 && hasDB) entities.push('[records]', '[metadata]');

    // AI
    const isOpenAI = hasTopic('openai') || hasFile('openai');
    const isGemini = hasTopic('gemini') || hasFile('gemini', 'google-generativeai');
    const isClaude = hasTopic('anthropic') || hasFile('anthropic', 'claude');
    const hasAI = isOpenAI || isGemini || isClaude
        || hasTopic('ai', 'ml', 'llm', 'langchain', 'chatbot')
        || hasFile('langchain', 'llm', 'embedding', 'vector');
    const aiLine1 = isOpenAI ? 'AI Layer — OpenAI API' : isGemini ? 'AI Layer — Google Gemini API' : isClaude ? 'AI Layer — Anthropic Claude API' : 'AI Layer — Language Model API';
    const aiLine2 = hasFile('langchain') ? 'LangChain orchestration pipeline' : hasFile('embedding', 'vector') ? 'Embedding & vector retrieval (RAG)' : hasFile('scaledown') ? 'Scaledown context compression' : 'Context processing & inference layer';

    // Tests / CI / Cloud
    const hasTests = hasFile('test/', 'tests/', '__tests__/', '.test.', '.spec.', 'pytest', 'jest.config', 'vitest.config');
    const testLabel = hasFile('pytest') ? 'pytest test suite' : hasFile('jest.config', '__tests__') ? 'Jest test suite' : hasFile('vitest') ? 'Vitest test suite' : 'Automated test suite';
    const hasCI = hasFile('.github/workflows', '.gitlab-ci', 'jenkinsfile', '.circleci', '.travis.yml');
    const ciLabel = hasFile('.github/workflows') ? 'GitHub Actions CI/CD' : hasFile('.gitlab-ci') ? 'GitLab CI/CD' : hasFile('jenkinsfile') ? 'Jenkins Pipeline' : 'CI/CD Pipeline';
    const hasDocker = hasTopic('docker') || hasFile('dockerfile', 'docker-compose');
    const hasK8s = hasTopic('kubernetes') || hasFile('kubernetes', 'k8s/', 'helm/');
    const isVercel = hasTopic('vercel') || hasFile('vercel.json');
    const isAWS = hasTopic('aws') || hasFile('serverless.yml', 'cdk.json', 'cloudformation');
    const hasCloud = hasDocker || hasK8s || isVercel || isAWS || hasTopic('gcp', 'azure', 'netlify', 'heroku', 'railway', 'render');
    const cloudLine1 = hasK8s ? 'Kubernetes Orchestration' : hasDocker ? 'Docker Container Runtime' : isAWS ? 'AWS Cloud Services' : isVercel ? 'Vercel Edge Network' : 'Cloud Deployment Layer';
    const cloudLine2 = hasK8s ? 'Container orchestration & auto-scaling' : hasDocker && hasFile('docker-compose') ? 'docker-compose multi-service stack' : hasDocker ? 'Containerised deployment' : isVercel ? 'Serverless functions & CDN' : 'Automated deployment pipeline';

    const supportLangs = languages.slice(1, 4).map((l) => l.name).join(' · ');

    // ═══ Assemble — one outer box ════════════════════════════════════════════
    const SEP = '─────────────────────────────────────────────────';
    const pad = (s: string, w: number) => s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length);
    const row = (c: string) => `│  ${pad(c, 47)}  │`;
    const blank = () => `│${' '.repeat(51)}│`;
    const iTop = () => `│  ┌─────────────────────────────────────────────┐  │`;
    const iBot = () => `│  └─────────────────────────────────────────────┘  │`;
    const iRow = (c: string) => `│  │  ${pad(c, 43)}│  │`;

    const rows: string[] = [];

    if (hasUI) {
        rows.push(row(pad(uiLabel, 47)));
        rows.push(`└─────────────────────┬───────────────────────────┘`);
        rows.push(`                      │ HTTP Requests`);
        rows.push(`┌─────────────────────▼───────────────────────────┐`);
    }
    rows.push(row(pad(appLabel, 47)));

    const n1 = pad(c1?.[0] ?? 'Core', 8), n2 = pad(c2?.[0] ?? 'Logic', 8), n3 = pad(c3?.[0] ?? 'Utils', 8);
    const r1 = pad(c1?.[1] ?? 'Layer ', 8), r2 = pad(c2?.[1] ?? 'Layer ', 8), r3 = pad(c3?.[1] ?? 'Layer ', 8);
    rows.push(`│  ┌──────────┐ ┌──────────┐ ┌──────────┐          │`);
    rows.push(`│  │  ${n1}  │ │  ${n2}  │ │  ${n3}  │          │`);
    rows.push(`│  │  ${r1}  │ │  ${r2}  │ │  ${r3}  │          │`);
    rows.push(`│  └────┬─────┘ └─────┬────┘ └─────┬────┘          │`);
    rows.push(`│       │             │             │                │`);

    if (hasORM || hasDB) {
        rows.push(`│  ┌────▼─────────────▼─────────────▼────────────┐  │`);
        rows.push(`│  │           ${pad(ormLabel, 34)}│  │`);
        rows.push(`│  └────────────────────┬──────────────────────┘    │`);
        rows.push(`│                       │                            │`);
    } else {
        rows.push(`│  ┌────▼─────────────▼─────────────▼────────────┐  │`);
        rows.push(`│  │           ${pad('Core Logic & Data Layer', 34)}│  │`);
        rows.push(`│  └────────────────────┬──────────────────────┘    │`);
        rows.push(`│                       │                            │`);
    }

    if (hasDB) {
        rows.push(`│  ┌────────────────────▼───────────────────────┐   │`);
        rows.push(`│  │  ${pad(dbLabel, 43)}│   │`);
        if (entities.length > 0) rows.push(`│  │  ${pad(entities.join(' '), 43)}│   │`);
        rows.push(`│  └────────────────────────────────────────────┘   │`);
    }

    if (supportLangs) { rows.push(blank()); rows.push(iTop()); rows.push(iRow(`Stack: ${supportLangs}`)); rows.push(iBot()); }
    if (hasAI) { rows.push(blank()); rows.push(iTop()); rows.push(iRow(aiLine1)); rows.push(iRow(aiLine2)); rows.push(iBot()); }
    if (hasTests) { rows.push(blank()); rows.push(iTop()); rows.push(iRow(`Testing — ${testLabel}`)); rows.push(iBot()); }
    if (hasCI) { rows.push(blank()); rows.push(iTop()); rows.push(iRow(`CI/CD — ${ciLabel}`)); rows.push(iBot()); }
    if (hasCloud) { rows.push(blank()); rows.push(iTop()); rows.push(iRow(cloudLine1)); rows.push(iRow(cloudLine2)); rows.push(iBot()); }

    return [`┌${SEP}┐`, ...rows, `└${SEP}┘`].join('\n');
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function fetchRepoAnalysis(repo: string): Promise<AnalysisResult> {
    const [owner, name] = repo.split('/');
    if (!owner || !name) throw new Error(`Invalid repo format: "${repo}". Expected "owner/repo".`);

    const [ghRepo, langRaw, commitsRaw, treeRaw] = await Promise.all([
        ghFetch<GhRepo>(`/repos/${repo}`),
        ghFetch<Record<string, number>>(`/repos/${repo}/languages`),
        ghFetch<GhCommit[]>(`/repos/${repo}/commits?per_page=100&since=${new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000).toISOString()}`),
        ghFetch<GhTree>(`/repos/${repo}/git/trees/${await getDefaultBranchSha(repo)}?recursive=1`),
    ]);

    const languages = mapLanguages(langRaw);
    const commits = aggregateCommits(commitsRaw);
    const fileItems = treeRaw.tree.filter((i) => i.type === 'blob' || i.type === 'tree');
    const fileTree = buildFileTree(fileItems, ghRepo.name);
    const filePaths = treeRaw.tree.map((i) => i.path);
    const fileCount = treeRaw.tree.filter((i) => i.type === 'blob').length;

    const rawScore = deriveComplexityScore(ghRepo, fileCount);
    const complexityLabel = complexityScoreToLabel(rawScore);

    const summary = ghRepo.description
        ? `${ghRepo.description} — ${fileCount} files across ${languages.length} languages, ${ghRepo.stargazers_count} stars, ${ghRepo.forks_count} forks.`
        : `A GitHub repository by ${ghRepo.owner.login} with ${fileCount} files, ${ghRepo.stargazers_count} stars, and ${ghRepo.forks_count} forks.`;

    return {
        projectName: ghRepo.name,
        projectOwner: ghRepo.owner.login,
        projectType: inferProjectType(ghRepo),
        techStack: inferTechStack(ghRepo),
        complexityScore: rawScore,
        complexityLabel,
        summary,
        keyFeatures: buildKeyFeatures(ghRepo, fileCount, treeRaw.truncated, filePaths, languages),
        fileTree,
        languages,
        commits,
        architectureDiagram: buildArchDiagram(ghRepo, languages, filePaths),
    };
}

async function getDefaultBranchSha(repo: string): Promise<string> {
    const ghRepo = await ghFetch<GhRepo>(`/repos/${repo}`);
    const branch = await ghFetch<{ commit: { sha: string } }>(`/repos/${repo}/branches/${ghRepo.default_branch}`);
    return branch.commit.sha;
}

/** Generate meaningful key features from repo metadata + file tree analysis */
function buildKeyFeatures(
    repo: GhRepo,
    fileCount: number,
    truncated: boolean,
    filePaths: string[],
    languages: MappedLanguageStat[],
): string[] {
    const files = filePaths.map((f) => f.toLowerCase());
    const topics = repo.topics.map((t) => t.toLowerCase());
    const hasF = (...kw: string[]) => files.some((f) => kw.some((k) => f.includes(k)));
    const hasT = (...kw: string[]) => kw.some((k) => topics.includes(k));

    const features: string[] = [];

    // Description first (if available)
    if (repo.description) features.push(repo.description);

    // Capabilities inferred from file structure
    if (hasF('auth', 'login', 'jwt', 'passport', 'oauth', 'session'))
        features.push('User authentication & session management');
    if (hasF('product', 'inventory', 'item', 'catalog', 'stock'))
        features.push('Product / inventory management with CRUD operations');
    if (hasF('bill', 'invoice', 'order', 'payment', 'stripe', 'checkout'))
        features.push('Billing, invoice generation & payment processing');
    if (hasF('analytics', 'dashboard', 'metrics', 'chart', 'report', 'stat'))
        features.push('Analytics dashboard with charts and KPIs');
    if (hasF('openai', 'gemini', 'anthropic', 'langchain', 'llm', 'embedding', 'chatbot'))
        features.push('AI / LLM integration for intelligent features');
    if (hasF('api/', 'routes/', 'controllers/', 'graphql', 'resolver', 'endpoint'))
        features.push('RESTful API with structured route controllers');
    if (hasF('socket.io', 'websocket', 'realtime', 'ws/'))
        features.push('Real-time communication via WebSockets');
    if (hasF('upload', 'multer', 'cloudinary', 's3', 'storage', 'media'))
        features.push('File upload & media storage support');
    if (hasF('test/', 'tests/', '__tests__/', '.test.', '.spec.', 'pytest', 'jest'))
        features.push('Automated test suite for reliability');
    if (hasF('dockerfile', 'docker-compose'))
        features.push('Dockerised for portable, reproducible deployment');
    if (hasF('.github/workflows', '.gitlab-ci', 'jenkinsfile'))
        features.push('CI/CD pipeline for automated builds & deploys');
    if (hasF('redis', 'cache', 'memcache'))
        features.push('Caching layer for improved performance');
    if (hasF('migrations/', 'alembic', 'schema.prisma'))
        features.push('Database migrations for schema version control');
    if (hasF('admin', 'role', 'permission', 'rbac'))
        features.push('Role-based access control (RBAC)');
    if (hasF('email', 'mail', 'smtp', 'sendgrid', 'mailgun'))
        features.push('Email notification & messaging system');
    if (hasF('pdf', 'export', 'fpdf', 'reportlab', 'weasyprint'))
        features.push('PDF generation & document export');

    // Language breakdown
    if (languages.length > 1) {
        const langStr = languages.slice(0, 3).map((l) => `${l.name} ${l.percentage}%`).join(', ');
        features.push(`Multi-language codebase: ${langStr}`);
    } else if (languages.length === 1) {
        features.push(`Written in ${languages[0]!.name} (${languages[0]!.percentage}% of codebase)`);
    }

    // Scale indicators
    features.push(`${fileCount}${truncated ? '+' : ''} source files across ${languages.length} language${languages.length !== 1 ? 's' : ''}`);
    if (repo.stargazers_count > 0)
        features.push(`${repo.stargazers_count.toLocaleString()} GitHub stars · ${repo.forks_count.toLocaleString()} forks`);
    if (repo.open_issues_count > 0)
        features.push(`${repo.open_issues_count} open issues being tracked`);
    if (!hasT(...topics) && topics.length > 0)
        features.push(`Tagged: ${topics.slice(0, 5).join(', ')}`);
    if (features.length < 3)
        features.push(`Hosted on GitHub by ${repo.owner.login}`);

    return features.slice(0, 8);
}
