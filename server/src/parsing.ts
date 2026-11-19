import { createRequire } from 'node:module';
import mammoth from 'mammoth';
import { HttpError } from './util.js';
import { detectDoc } from './services.js';

const require = createRequire(import.meta.url);

export async function extractText(buf: Buffer): Promise<{ text: string; type: string }> {
  const type = detectDoc(buf);
  if (!type) throw new HttpError(415, 'Unsupported file. Upload PDF, DOC, DOCX or TXT.', 'unsupported_type');
  try {
    if (type === 'pdf') {
      const pdf = require('pdf-parse/lib/pdf-parse.js');
      const r = await pdf(buf);
      return { text: String(r.text || ''), type };
    }
    if (type === 'docx') {
      const r = await mammoth.extractRawText({ buffer: buf });
      return { text: r.value || '', type };
    }
    if (type === 'txt') return { text: buf.toString('utf8'), type };
    // Legacy .doc: best-effort printable text extraction
    return { text: buf.toString('latin1').replace(/[^\x20-\x7E\n]+/g, ' '), type };
  } catch {
    throw new HttpError(422, 'Could not read this document. It may be corrupted or password-protected.', 'parse_failed');
  }
}

export const SKILLS = [
  'javascript', 'typescript', 'node.js', 'nodejs', 'react', 'redux', 'next.js', 'vue', 'angular', 'svelte', 'html', 'css', 'tailwind', 'sass',
  'python', 'django', 'flask', 'fastapi', 'java', 'spring', 'spring boot', 'kotlin', 'swift', 'c#', '.net', 'asp.net', 'c++', 'c', 'go', 'golang', 'rust', 'ruby', 'rails', 'php', 'laravel',
  'sql', 'mysql', 'postgresql', 'postgres', 'mongodb', 'redis', 'elasticsearch', 'kafka', 'rabbitmq', 'graphql', 'rest', 'grpc', 'microservices',
  'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'terraform', 'ansible', 'jenkins', 'ci/cd', 'git', 'linux', 'nginx',
  'machine learning', 'deep learning', 'tensorflow', 'pytorch', 'pandas', 'numpy', 'spark', 'hadoop', 'data analysis', 'power bi', 'tableau',
  'android', 'ios', 'react native', 'flutter', 'figma', 'ui/ux', 'testing', 'jest', 'cypress', 'selenium', 'junit', 'agile', 'scrum', 'jira',
  'system design', 'data structures', 'algorithms', 'oop', 'webrtc', 'websocket', 'devops', 'sre', 'security', 'leadership', 'communication', 'sales', 'recruitment', 'excel',
];
const skillRe = (s: string) => new RegExp(`(^|[^a-z0-9+#.])${s.replace(/[.+*?^${}()|[\]\\/]/g, '\\$&')}(?![a-z0-9+#])`, 'i');

export function findSkills(text: string): string[] {
  const found = SKILLS.filter(s => skillRe(s).test(text));
  const canon = (s: string) => (s === 'nodejs' ? 'node.js' : s === 'postgres' ? 'postgresql' : s === 'golang' ? 'go' : s);
  return [...new Set(found.map(canon))];
}

function section(text: string, headings: string[], stops: string[]) {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let on = false;
  const isHead = (l: string, list: string[]) => list.some(h => new RegExp(`^\\s*(${h})\\s*:?\\s*$`, 'i').test(l.trim()));
  for (const l of lines) {
    if (isHead(l, headings)) { on = true; continue; }
    if (on && isHead(l, stops)) break;
    if (on) out.push(l);
  }
  return out.join('\n').trim();
}

export function parseJD(text: string) {
  const first = text.split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
  const stops = ['responsibilities', 'requirements', 'qualifications', 'skills', 'required skills', 'preferred skills', 'nice to have', 'about us', 'benefits', 'what we offer'];
  const exp = text.match(/(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\+?\s*(?:years|yrs)/i);
  const expSingle = text.match(/(\d{1,2})\+?\s*(?:years|yrs)/i);
  const loc = text.match(/location\s*[:\-]\s*(.+)/i)?.[1]?.trim();
  const dept = text.match(/department\s*[:\-]\s*(.+)/i)?.[1]?.trim();
  const type = text.match(/\b(full[- ]time|part[- ]time|contract|internship|freelance)\b/i)?.[1];
  const preferredText = section(text, ['preferred skills', 'nice to have', 'good to have', 'preferred'], stops);
  const preferred = findSkills(preferredText);
  const required = findSkills(text).filter(s => !preferred.includes(s));
  return {
    title: first.replace(/^(job title|position|role)\s*[:\-]\s*/i, '').slice(0, 120),
    department: dept, location: loc, employment_type: type ? type.replace(/\s+/g, '-').toLowerCase() : undefined,
    exp_min: exp ? Number(exp[1]) : expSingle ? Number(expSingle[1]) : undefined, exp_max: exp ? Number(exp[2]) : undefined,
    responsibilities: section(text, ['responsibilities', 'key responsibilities', 'what you will do', 'duties'], stops) || undefined,
    qualifications: section(text, ['qualifications', 'requirements', 'education'], stops) || undefined,
    required_skills: required, preferred_skills: preferred, description: text.slice(0, 20000),
  };
}

export function parseResume(text: string) {
  const email = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0];
  const phone = text.match(/(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{3,5}\)?[\s-]?)\d{3,5}[\s-]?\d{3,5}/)?.[0]?.trim();
  const name = text.split(/\r?\n/).map(l => l.trim()).find(l => l && l.length < 60 && !/@|resume|curriculum|\d{4}/i.test(l));
  const yrs = [...text.matchAll(/(\d{1,2}(?:\.\d)?)\+?\s*(?:years|yrs)/gi)].map(m => Number(m[1])).filter(n => n < 45);
  return { name, email, phone, skills: findSkills(text), experience_years: yrs.length ? Math.max(...yrs) : undefined };
}

/**
 * Transparent keyword-overlap match. DECISION SUPPORT ONLY: never used to reject candidates automatically.
 * It does not consider name, gender, age, photo, accent or any protected characteristic.
 */
export function matchScore(job: { required_skills: string[]; preferred_skills: string[]; exp_min?: number | null }, cand: { skills: string[]; experience_years?: number | null }) {
  const cs = new Set(cand.skills.map(s => s.toLowerCase()));
  const req = job.required_skills.map(s => s.toLowerCase()), pref = job.preferred_skills.map(s => s.toLowerCase());
  const reqHit = req.filter(s => cs.has(s)), prefHit = pref.filter(s => cs.has(s));
  const reqPart = req.length ? reqHit.length / req.length : 1;
  const prefPart = pref.length ? prefHit.length / pref.length : 1;
  const expPart = job.exp_min && cand.experience_years != null ? Math.min(1, cand.experience_years / job.exp_min) : 1;
  const score = Math.round((reqPart * 0.65 + prefPart * 0.15 + expPart * 0.2) * 100);
  return {
    score,
    detail: {
      matchedRequired: reqHit, missingRequired: req.filter(s => !cs.has(s)), matchedPreferred: prefHit,
      experienceNote: job.exp_min && cand.experience_years != null ? `${cand.experience_years} yrs vs ${job.exp_min}+ requested` : 'Experience not compared',
      disclaimer: 'Keyword-based decision support. It cannot judge ability or potential and must not be used to reject candidates automatically.',
    },
  };
}
