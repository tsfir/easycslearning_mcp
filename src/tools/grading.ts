/**
 * Group 8 — Grading tools
 *
 * Tools:
 *   grade_student_answer — grade a transcribed handwritten answer with Gemini AI
 *                          and optionally save the result to Firestore.
 *
 * Requires GEMINI_API_KEY environment variable in the MCP server config.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../firestore.js';
import { resolveCourse, resolveTopic, resolveLesson, resolveSection, resolveStudent } from '../resolvers.js';
import { gradeWithGemini, buildGradingSystemPrompt, getGeminiApiKey } from '../gemini.js';

export function registerGradingTools(server: McpServer): void {

    // ── grade_student_answer ─────────────────────────────────────────────────
    server.tool(
        'grade_student_answer',
        [
            'Grade a student\'s transcribed handwritten answer using Gemini AI.',
            '',
            'Typical workflow:',
            '  1. Teacher scans a handwritten exam page.',
            '  2. Claude reads the image and transcribes the student\'s answer.',
            '  3. Claude calls this tool with the transcribed text.',
            '  4. The tool runs AI grading and returns a grade + Hebrew feedback.',
            '  5. If saveGrade is true (default), the result is saved to Firestore.',
            '',
            'The grading uses the course\'s custom prompt template (if any) on top of',
            'the global Oakley AI grading system prompt — identical to the web grader.',
            '',
            'Requires GEMINI_API_KEY to be set in the MCP server environment.',
        ].join('\n'),
        {
            courseName: z.string().describe('Course name or partial name'),
            lessonName: z.string().describe('Lesson name or partial name'),
            sectionTitle: z.string().describe('Section (question) title or partial title. Use get_lesson_content to list available sections.'),
            studentName: z.string().describe('Student full name or partial name'),
            transcribedAnswer: z.string().min(1).describe('The student\'s handwritten answer transcribed to text'),
            saveGrade: z.boolean().optional()
                .describe('Save the grade and answer to Firestore — default true. Set false to preview before saving.'),
        },
        async ({ courseName, lessonName, sectionTitle, studentName, transcribedAnswer, saveGrade = true }) => {
            // Verify API key is available before doing any Firestore work
            getGeminiApiKey();

            const db = getDb();

            // ── Resolve all entities ─────────────────────────────────────────
            const { courseId, courseName: resolvedCourse } = await resolveCourse(db, courseName);
            const { lessonId, lessonName: resolvedLesson } = await resolveLesson(db, courseId, lessonName);
            const section = await resolveSection(db, lessonId, sectionTitle);
            const student = await resolveStudent(db, courseId, studentName);

            // ── Fetch course grading prompt config ───────────────────────────
            const courseDoc = await db.collection('courses').doc(courseId).get();
            const courseData = courseDoc.data() ?? {};
            const gradingPromptTemplate = (courseData.gradingPromptTemplate as string | undefined) ?? null;
            const gradingPromptMode = (courseData.gradingPromptMode as 'default' | 'extend' | 'override' | undefined);

            // ── Fetch global system prompt from Firestore (fall back to default) ──
            let dbDefault: string | undefined;
            try {
                const promptDoc = await db.collection('systemPrompts').doc('grading').get();
                if (promptDoc.exists) {
                    dbDefault = promptDoc.data()?.content as string | undefined;
                }
            } catch {
                // systemPrompts collection may not exist — use hardcoded default
            }

            const systemPrompt = buildGradingSystemPrompt(
                gradingPromptTemplate,
                section.points,
                gradingPromptMode,
                dbDefault
            );

            // ── Run AI grading ───────────────────────────────────────────────
            const result = await gradeWithGemini(
                section.content,
                transcribedAnswer,
                section.points,
                section.language,
                systemPrompt
            );

            // ── Optionally save to Firestore ─────────────────────────────────
            let savedDocId: string | null = null;

            if (saveGrade) {
                const now = new Date().toISOString();

                // Check for an existing answer document for this student + section
                const existingSnap = await db.collection('studentAnswers')
                    .where('sectionId', '==', section.sectionId)
                    .where('userId', '==', student.userId)
                    .limit(1)
                    .get();

                if (!existingSnap.empty) {
                    // Update existing record
                    const ref = existingSnap.docs[0].ref;
                    await ref.update({
                        answer: transcribedAnswer,
                        grade: result.grade,
                        feedback: result.feedback,
                        gradedByTeacher: true,
                        handwritten: true,
                        updatedAt: now,
                    });
                    savedDocId = ref.id;
                } else {
                    // Create a new record
                    const ref = await db.collection('studentAnswers').add({
                        sectionId: section.sectionId,
                        lessonId,
                        courseId,
                        userId: student.userId,
                        answer: transcribedAnswer,
                        type: section.type,
                        grade: result.grade,
                        feedback: result.feedback,
                        gradedByTeacher: true,
                        handwritten: true,
                        createdAt: now,
                        updatedAt: now,
                    });
                    savedDocId = ref.id;
                }

                // ── Write grading feedback to aiChats so student sees it ──────
                const percentage = Math.round((result.grade / section.points) * 100);
                const feedbackMessage = {
                    role: 'assistant',
                    content: `**ציון: ${result.grade}/${section.points} (${percentage}%)**\n\n${result.feedback}`,
                    timestamp: now,
                };

                const chatSnap = await db.collection('aiChats')
                    .where('userId', '==', student.userId)
                    .where('lessonId', '==', lessonId)
                    .limit(1)
                    .get();

                if (chatSnap.empty) {
                    await db.collection('aiChats').add({
                        userId: student.userId,
                        lessonId,
                        messages: [feedbackMessage],
                        createdAt: now,
                        updatedAt: now,
                    });
                } else {
                    const existing = chatSnap.docs[0].data();
                    await chatSnap.docs[0].ref.update({
                        messages: [...(existing.messages as unknown[] || []), feedbackMessage],
                        updatedAt: now,
                    });
                }
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        course: resolvedCourse,
                        lesson: resolvedLesson,
                        section: section.sectionTitle,
                        student: student.fullName,
                        maxPoints: section.points,
                        grade: result.grade,
                        percentage: Math.round((result.grade / section.points) * 100),
                        feedback: result.feedback,
                        saved: saveGrade,
                        ...(savedDocId && { answerId: savedDocId }),
                    }, null, 2),
                }],
            };
        }
    );
}
