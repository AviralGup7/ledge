import noCommentedCode from './rules/no-commented-code.js';
import noRawCopy from './rules/no-raw-copy.js';
import registryPurity from './rules/registry-purity.js';
import rootsComposition from './rules/roots-composition.js';

export default {
  rules: {
    'no-commented-code': noCommentedCode,
    'no-raw-copy': noRawCopy,
    'registry-purity': registryPurity,
    'roots-composition': rootsComposition,
  },
};
