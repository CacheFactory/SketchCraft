// @archigraph op.index
// Re-exports for all geometry operations

// Core operations
export { ExtrudeOperation } from './ExtrudeOperation';
export type { ExtrudeParams, ExtrudeResult } from './ExtrudeOperation';

export { OffsetOperation } from './OffsetOperation';
export type { OffsetParams, OffsetResult } from './OffsetOperation';

export { SweepOperation } from './SweepOperation';
export type { SweepParams, SweepResult } from './SweepOperation';

// Boolean / CSG operations
export { BooleanUnion } from './BooleanUnion';
export type { MeshRegion, BooleanUnionParams, BooleanResult } from './BooleanUnion';

export { BooleanSubtract } from './BooleanSubtract';
export type { BooleanSubtractParams } from './BooleanSubtract';

export { BooleanIntersect } from './BooleanIntersect';
export type { BooleanIntersectParams } from './BooleanIntersect';

// Edge operations
export { FilletOperation } from './FilletOperation';
export type { FilletParams, FilletResult } from './FilletOperation';

export { ChamferOperation } from './ChamferOperation';
export type { ChamferParams, ChamferResult } from './ChamferOperation';

// Mesh operations
export { SubdivideOperation } from './SubdivideOperation';
export type { SubdivideParams, SubdivideResult, SubdivisionMethod } from './SubdivideOperation';

export { TriangulateOperation } from './TriangulateOperation';
export type { TriangulateParams, TriangulateResult } from './TriangulateOperation';

export { IntersectFacesOperation } from './IntersectFacesOperation';
export type { IntersectFacesParams, IntersectFacesResult } from './IntersectFacesOperation';

// Validation
export { SolidManifold } from './SolidManifold';
export type { ManifoldCheckParams, ManifoldCheckResult, ManifoldIssue } from './SolidManifold';
export { ManifoldIssueType } from './SolidManifold';

// Modifiers
export { ArrayModifier } from './ArrayModifier';
export type { ArrayParams, LinearArrayParams, PolarArrayParams, ArrayResult } from './ArrayModifier';

export { MirrorModifier } from './MirrorModifier';
export type { MirrorParams, MirrorResult } from './MirrorModifier';

export { SmoothModifier } from './SmoothModifier';
export type { SmoothParams, SmoothResult } from './SmoothModifier';
