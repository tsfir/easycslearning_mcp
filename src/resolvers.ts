/**
 * Name-to-ID resolvers.
 *
 * Claude speaks in human names ("C# for Beginners", "Yod 4").
 * These helpers translate them to Firestore document IDs via
 * case-insensitive, partial-match lookups.
 */

import { Firestore } from '@google-cloud/firestore';

function normalize(s: string): string {
    return s.toLowerCase().trim();
}

function matches(haystack: string, needle: string): boolean {
    return normalize(haystack).includes(normalize(needle));
}

// ─── Courses ─────────────────────────────────────────────────────────────────

export interface CourseRef {
    courseId: string;
    courseName: string;
}

export async function resolveCourse(db: Firestore, courseName: string): Promise<CourseRef> {
    const snap = await db.collection('courses').get();
    const match = snap.docs.find(d => matches(d.data().courseName ?? '', courseName));
    if (!match) throw new Error(`Course not found: "${courseName}". Run list_courses to see available courses.`);
    return { courseId: match.id, courseName: match.data().courseName };
}

// ─── Topics ──────────────────────────────────────────────────────────────────

export interface TopicRef {
    topicId: string;
    topicName: string;
}

export async function resolveTopic(db: Firestore, courseId: string, topicName: string): Promise<TopicRef> {
    const snap = await db.collection('topics').where('courseId', '==', courseId).get();
    const match = snap.docs.find(d => matches(d.data().topicName ?? '', topicName));
    if (!match) throw new Error(`Topic not found: "${topicName}" in the given course.`);
    return { topicId: match.id, topicName: match.data().topicName };
}

// ─── Lessons ─────────────────────────────────────────────────────────────────

export interface LessonRef {
    lessonId: string;
    lessonName: string;
    topicId: string;
}

export async function resolveLesson(db: Firestore, courseId: string, lessonName: string): Promise<LessonRef> {
    const snap = await db.collection('lessons').where('courseId', '==', courseId).get();
    const match = snap.docs.find(d => matches(d.data().lessonName ?? '', lessonName));
    if (!match) throw new Error(`Lesson not found: "${lessonName}" in the given course.`);
    const data = match.data();
    return { lessonId: match.id, lessonName: data.lessonName, topicId: data.topicId };
}

// ─── Sections ────────────────────────────────────────────────────────────────

export interface SectionRef {
    sectionId: string;
    sectionTitle: string;
    content: string;
    points: number;
    language?: string;
    type: string;
}

export async function resolveSection(db: Firestore, lessonId: string, sectionTitle: string): Promise<SectionRef> {
    const snap = await db.collection('sections').where('lessonId', '==', lessonId).get();
    const match = snap.docs.find(d => matches(d.data().title ?? '', sectionTitle));
    if (!match) throw new Error(`Section not found: "${sectionTitle}" in the given lesson. Use get_lesson_content to list available sections.`);
    const data = match.data();
    return {
        sectionId: match.id,
        sectionTitle: data.title,
        content: data.content ?? '',
        points: (data.points as number) ?? 10,
        language: data.language as string | undefined,
        type: data.type as string,
    };
}

// ─── Students (course-scoped) ─────────────────────────────────────────────────

export async function resolveStudent(db: Firestore, courseId: string, studentName: string): Promise<StudentRef> {
    const students = await getAllStudentsInCourse(db, courseId);
    const match = students.find(s => matches(s.fullName, studentName));
    if (!match) throw new Error(`Student not found: "${studentName}" in the given course. Use get_class_roster to list enrolled students.`);
    return match;
}

// ─── Classes ─────────────────────────────────────────────────────────────────

export interface ClassRef {
    classId: string;
    className: string;
}

export async function resolveClass(db: Firestore, courseId: string, className: string): Promise<ClassRef> {
    const snap = await db.collection('courseClasses').where('courseId', '==', courseId).get();
    const match = snap.docs.find(d => matches(d.data().name ?? '', className));
    if (!match) throw new Error(`Class not found: "${className}" in the given course.`);
    return { classId: match.id, className: match.data().name };
}

// ─── Students in a class ─────────────────────────────────────────────────────

export interface StudentRef {
    userId: string;
    fullName: string;
    email?: string;
}

export async function getStudentsInClass(db: Firestore, courseId: string, classId: string): Promise<StudentRef[]> {
    const progressSnap = await db.collection('userProgress')
        .where('courseId', '==', courseId)
        .where('classId', '==', classId)
        .get();

    const userIds = progressSnap.docs.map(d => d.data().userId as string);
    if (userIds.length === 0) return [];

    // Firestore 'in' query supports max 30 items; chunk if needed
    const students: StudentRef[] = [];
    for (let i = 0; i < userIds.length; i += 30) {
        const chunk = userIds.slice(i, i + 30);
        const usersSnap = await db.collection('users')
            .where('__name__', 'in', chunk)
            .get();
        usersSnap.docs.forEach(d => students.push({
            userId: d.id,
            fullName: d.data().fullName ?? 'Unknown',
            email: d.data().email,
        }));
    }
    return students.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function getAllStudentsInCourse(db: Firestore, courseId: string): Promise<StudentRef[]> {
    const progressSnap = await db.collection('userProgress')
        .where('courseId', '==', courseId)
        .get();

    const userIds = [...new Set(progressSnap.docs.map(d => d.data().userId as string))];
    if (userIds.length === 0) return [];

    const students: StudentRef[] = [];
    for (let i = 0; i < userIds.length; i += 30) {
        const chunk = userIds.slice(i, i + 30);
        const usersSnap = await db.collection('users')
            .where('__name__', 'in', chunk)
            .get();
        usersSnap.docs.forEach(d => students.push({
            userId: d.id,
            fullName: d.data().fullName ?? 'Unknown',
            email: d.data().email,
        }));
    }
    return students.sort((a, b) => a.fullName.localeCompare(b.fullName));
}
