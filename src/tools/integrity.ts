/**
 * Group 6 — Integrity tools
 *
 * Tools:
 *   get_integrity_flags — plagiarism / suspicion flags for a course
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../firestore.js';
import { resolveCourse, resolveClass, getStudentsInClass } from '../resolvers.js';

export function registerIntegrityTools(server: McpServer): void {

    server.tool(
        'get_integrity_flags',
        'Get academic integrity flags (plagiarism / suspicious behaviour) for a course. Returns student name, lesson, exercise, flag types and severity.',
        {
            courseName: z.string().describe('Course name or partial name'),
            severity: z.enum(['high', 'medium', 'low', 'all']).optional()
                .describe('Filter by severity: "high", "medium", "low", or "all" (default)'),
            className: z.string().optional().describe('Class name to filter — optional'),
            showDismissed: z.boolean().optional().describe('Include already-dismissed flags — default false'),
        },
        async ({ courseName, severity = 'all', className, showDismissed = false }) => {
            const db = getDb();
            const { courseId, courseName: resolvedCourse } = await resolveCourse(db, courseName);

            let query = db.collection('plagiarismFlags').where('courseId', '==', courseId);

            if (!showDismissed) {
                query = query.where('dismissed', '==', false);
            }
            if (severity !== 'all') {
                query = query.where('overallSeverity', '==', severity);
            }

            const flagsSnap = await query.get();
            let flags = flagsSnap.docs.map(d => {
                const data = d.data();
                return {
                    student: data.fullName,
                    userId: data.userId as string,
                    lessonName: data.lessonName,
                    exercise: data.sectionTitle,
                    overallSeverity: data.overallSeverity,
                    dismissed: data.dismissed,
                    flagTypes: (data.flags as Array<{ type: string; severity: string; detail: string }>)
                        .map(f => ({ type: f.type, severity: f.severity, detail: f.detail })),
                    createdAt: data.createdAt,
                };
            });

            // Filter by class if requested
            if (className) {
                const cls = await resolveClass(db, courseId, className);
                const classStudents = await getStudentsInClass(db, courseId, cls.classId);
                const ids = new Set(classStudents.map(s => s.userId));
                flags = flags.filter(f => ids.has(f.userId));
            }

            // Sort: high severity first, then by date
            const severityOrder: Record<string, number> = { high: 3, medium: 2, low: 1 };
            flags.sort((a, b) => {
                const sev = (severityOrder[b.overallSeverity] ?? 0) - (severityOrder[a.overallSeverity] ?? 0);
                if (sev !== 0) return sev;
                return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
            });

            const output = flags.map(({ userId: _uid, ...rest }) => rest);

            const severityCounts = { high: 0, medium: 0, low: 0 };
            output.forEach(f => {
                if (f.overallSeverity in severityCounts) {
                    severityCounts[f.overallSeverity as keyof typeof severityCounts]++;
                }
            });

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        course: resolvedCourse,
                        class: className ?? 'All Students',
                        totalFlags: output.length,
                        severityBreakdown: severityCounts,
                        flags: output,
                    }, null, 2),
                }],
            };
        }
    );
}
