import React from 'react';
import { StyleStudio } from '../documents/StyleStudio';

/**
 * The Style Studio on the ORGANIZATION alone — no booklet in hand.
 *
 * The studio has always been able to edit the org template; it was only ever reachable by
 * opening a booklet and flipping a segmented control, which is a strange road to the house
 * style. With no `documentId` it locks to org scope, lays the specimen out on the org's own
 * page format, and skips every document-scoped call (see the prop's own note).
 *
 * It fills the whole panel rather than sitting in the settings page's padding: it is a
 * specimen page beside a roles panel, and both want the height.
 */
export const StylesPanel: React.FC = () => <StyleStudio />;
