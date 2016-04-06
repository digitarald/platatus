import path from 'path';
import fs from 'fs';
import url from 'url';
import handlebars from 'handlebars';
import Bottleneck from 'bottleneck';
import slug from 'slug';
slug.defaults.mode = 'rfc3986';
import FixtureParser from './fixtureParser.js';
import BrowserParser from './browserParser.js';
import FirefoxVersionParser from './firefoxVersionParser.js';
import CanIUseParser from './canIUseParser.js';
import cache from './cache.js';
import redis from './redis-helper.js';

const fixtureDir = path.resolve('./features');
const fixtureParser = new FixtureParser(fixtureDir);
const browserParser = new BrowserParser();
const firefoxVersionParser = new FirefoxVersionParser();
const canIUseParser = new CanIUseParser();
let validationWarnings;

function validateWarning(msg) {
  validationWarnings.push(msg);
}

function normalizeStatus(status, browser) {
  switch (status.trim().toLowerCase()) {
    case '':
    case 'unknown':
      return 'unknown';
    case 'no active development':
    case 'not currently planned':
    case 'not considering':
    case 'not-planned':
      return 'not-planned';
    case 'deprecated':
    case 'no longer pursuing':
    case 'removed':
      return 'deprecated';
    case 'under consideration':
    case 'proposed':
    case 'under-consideration':
      return 'under-consideration';
    case 'in development':
    case 'behind a flag':
    case 'in experimental framework':
    case 'prototyping':
    case 'preview release':
    case 'in-development':
      return 'in-development';
    case 'shipped':
    case 'enabled by default':
    case 'done':
    case 'partial support':
    case 'prefixed':
      return 'shipped';
    default:
      throw new Error(`Unmapped status: "${status}" for "${browser}"`);
  }
}

class BrowserFeature {
  constructor(data) {
    this.data = data;
  }

  get status() {
    return normalizeStatus(this._rawStatus, this.name);
  }
}

class ChromeBrowserFeature extends BrowserFeature {
  constructor(data) {
    super(data);
    this.name = 'chrome';
  }

  get _rawStatus() {
    return this.data.impl_status_chrome;
  }
  get url() {
    return url.format({
      host: 'www.chromestatus.com',
      pathname: `/feature/${this.data.id}`,
      protocol: 'https:',
    });
  }
}

ChromeBrowserFeature.defaultUrl = 'https://www.chromestatus.com/features';

class OperaBrowserFeature extends ChromeBrowserFeature {
  constructor(data) {
    super(data);
    this.name = 'opera';
  }

  get _rawStatus() {
    return this.data.shipped_opera_milestone ? 'shipped' : '';
  }
}

class WebKitBrowserFeature extends BrowserFeature {
  constructor(data) {
    super(data);
    this.name = 'webkit';
  }
  get _rawStatus() {
    return this.data.status ? this.data.status.status : '';
  }
  get url() {
    const slugName = slug(this.data.name);
    return url.format({
      host: 'www.webkit.org',
      pathname: '/status.html',
      hash: `#${this.data.type}-${slugName}`,
      protocol: 'https:',
    });
  }
}

WebKitBrowserFeature.defaultUrl = 'https://www.webkit.org/status.html';

class IEBrowserFeature extends BrowserFeature {
  constructor(data) {
    super(data);
    this.name = 'ie';
  }
  get _rawStatus() {
    return this.data.ieStatus.text;
  }
  get url() {
    const name = this.data.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    return url.format({
      host: 'dev.modern.ie',
      pathname: `/platform/status/${name}`,
      protocol: 'https:',
    });
  }
}

IEBrowserFeature.defaultUrl = 'https://dev.modern.ie/platform/status/';

const allBrowserFeatures = [
  ['chrome', 'chrome', ChromeBrowserFeature],
  ['opera', 'chrome', OperaBrowserFeature],
  ['webkit', 'webkit', WebKitBrowserFeature],
  ['ie', 'ie', IEBrowserFeature],
];

function populateBrowserFeatureData(browserData, features) {
  features.forEach((feature) => {
    allBrowserFeatures.forEach(([key, relKey, BrowserFeatureConstructor]) => {
      const statusKey = `${key}_status`;
      const urlKey = `${key}_url`;
      const relKeyRef = `${relKey}_ref`;

      if (!feature[statusKey]) {
        feature[statusKey] = 'unknown';
      } else {
        feature[statusKey] = normalizeStatus(feature[statusKey], key);
      }
      feature[urlKey] = BrowserFeatureConstructor.defaultUrl;

      if (!feature[relKeyRef]) {
        return;
      }

      const browserFeatureData = browserData[relKey].get(feature[relKeyRef]);
      if (!browserFeatureData) {
        throw new Error(`Wrong value for ${relKey} in ${feature.file}`);
      }

      const browserFeature = new BrowserFeatureConstructor(browserFeatureData);
      feature[statusKey] = browserFeature.status;
      feature[urlKey] = browserFeature.url;
    });
  });

  // Temporarily assume that features that are in development for Chrome are also
  // in development for Opera (at least until
  // https://github.com/GoogleChrome/chromium-dashboard/issues/263 is fixed).
  features.forEach(feature => {
    if (feature.opera_status === 'unknown' && feature.chrome_status === 'in-development') {
      feature.opera_status = 'in-development';
    }
  });
}

// For now, only fill in data for WebKit (Safari) and Opera.
function fillInUsingCanIUseData(canIUseData, features) {
  let filledInNum = 0;

  features.forEach(feature => {
    if (feature.caniuse_ref) {
      const data = canIUseData.data[feature.caniuse_ref];

      [{
        browser: 'opera',
        engine: 'opera',
      },
      {
        browser: 'safari',
        engine: 'webkit',
      }].forEach(({ browser, engine }) => {
        if (feature[`${engine}_status`] !== 'unknown') {
          return;
        }

        const versions = canIUseData.agents[browser].versions;
        const stableVersion = versions[versions.length - 4];

        if (data.stats[browser][stableVersion] === 'y') {
          filledInNum++;
          feature[`${engine}_status`] = 'shipped';
        } else if (Object.values(data.stats[browser]).some(v => v.includes('y'))) {
          filledInNum++;
          feature[`${engine}_status`] = 'in-development';
        }
      });

      if (!feature.spec_url && data.spec) {
        filledInNum++;
        feature.spec_url = data.spec;
      }
    }
  });

  console.log(`${filledInNum} properties filled in from caniuse data`);
}

function populateSpecStatus(browserData, features) {
  features.forEach((feature) => {
    const browserFeatureData = browserData.chrome.get(feature.chrome_ref);
    if (!browserFeatureData || !browserFeatureData.standardization) {
      return;
    }
    let normalized;
    const status = browserFeatureData.standardization.text;
    switch (status) {
      case 'De-facto standard':
        normalized = 'de-facto-standard';
        break;
      case 'Editor\'s draft':
        normalized = 'editors-draft';
        break;
      case 'Established standard':
        normalized = 'established-standard';
        break;
      case 'No public standards discussion':
        normalized = 'no-public-discussion';
        break;
      case 'Public discussion':
        normalized = 'public-discussion';
        break;
      case 'Working draft or equivalent':
        normalized = 'working-draft-or-equivalent';
        break;
      default:
        validateWarning(`Unmapped standardization status: ${status}`);
        normalized = 'invalid';
        break;
    }
    feature.spec_status = normalized;
  });
}

// Bugzilla has a limit on concurrent connections. I haven't found what the
// limit is, but 20 seems to work.
const bugzillaBottleneck = new Bottleneck(20);

function bugzillaFetch(bugzillaUrl) {
  return bugzillaBottleneck.schedule(cache.readJson, bugzillaUrl);
}

function getBugzillaBugData(bugId, options) {
  const includeFields = options.include_fields.join(',');
  return bugzillaFetch(`https://bugzilla.mozilla.org/rest/bug?id=${bugId}&include_fields=${includeFields}`, options)
  .then((json) => {
    if (!json.bugs.length) {
      throw new Error('Bug not found(secure bug?)');
    }
    return json.bugs[0];
  })
  .catch((reason) => {
    validateWarning(`Failed to get bug data for: ${bugId}: ${reason}`);
    return null;
  });
}

function populateBugzillaData(features, options) {
  return Promise.all(features.map((feature) => {
    if (!feature.bugzilla) {
      return null;
    }
    return getBugzillaBugData(feature.bugzilla, Object.assign(options, { include_fields: ['status', 'depends_on', 'id'] }))
    .then((bugData) => {
      if (!bugData) {
        feature.bugzilla_status = null;
        return null;
      }
      feature.bugzilla_status = bugData.status;
      feature.bugzilla_resolved_count = (bugData.status === 'RESOLVED') ? 1 : 0;
      // Add one to show status of the tracking bug itself.
      feature.bugzilla_dependant_count = bugData.depends_on.length + 1;
      if (!bugData.depends_on.length) {
        return null;
      }
      // Check all the dependent bugs to count how many are resolved.
      const dependsOn = bugData.depends_on.join(',');
      return bugzillaFetch(`https://bugzilla.mozilla.org/rest/bug?id=${dependsOn}&status=RESOLVED&include_fields=id`, options)
      .then((dependentResult) => {
        feature.bugzilla_resolved_count += dependentResult.bugs.length;
      });
    });
  }));
}

function populateFirefoxStatus(versions, features) {
  features.forEach((feature) => {
    if (!isNaN(feature.firefox_status)) {
      const version = parseInt(feature.firefox_status, 10);
      feature.firefox_version = version;
      if (version <= versions.aurora) {
        feature.firefox_status = 'shipped';
      } else {
        feature.firefox_status = 'in-development';
      }

      if (version <= versions.stable) {
        feature.firefox_channel = 'release';
      } else if (version === versions.beta) {
        feature.firefox_channel = 'beta';
      } else if (version === versions.aurora) {
        feature.firefox_channel = 'developer-edition';
      } else if (version === versions.nightly) {
        feature.firefox_channel = 'nightly';
      }
    } else {
      feature.firefox_status = normalizeStatus(feature.firefox_status, 'firefox');
    }
  });
}

function populateCanIUsePercent(canIUseData, features) {
  features.forEach((feature) => {
    if (!feature.caniuse_ref) {
      validateWarning(`${feature.file}: missing caniuse_ref`);
      return;
    }
    const data = canIUseData.data[feature.caniuse_ref];
    if (!data) {
      validateWarning(`${feature.file}: invalid caniuse_ref ${feature.caniuse_ref}`);
      return;
    }
    feature.caniuse_usage_perc_y = data.usage_perc_y;
    feature.caniuse_usage_perc_a = data.usage_perc_a;
    feature.caniuse_usage_perc_total = Math.round(data.usage_perc_y + data.usage_perc_a);
  });
}

const statusFields = ['firefox_status', 'spec_status', 'opera_status',
                      'webkit_status', 'ie_status'];
// checking for changes in 'status' object
function checkForNewData(features, dbTestNumber) {
  return redis.getClient(dbTestNumber)
  .then(client => redis.get(client, 'status')
    .then((oldStatus) => {
      try {
        oldStatus = JSON.parse(oldStatus);
      } catch (e) {
        console.error(e, oldStatus);
      }
      if (!oldStatus) {
        oldStatus = {};
      }
      features.forEach((feature) => {
        feature.updated = {};
        if (!oldStatus[feature.slug]) {
          feature.just_started = true;
        } else {
          // XXX: check if that can happen outside of test...
          if (feature.just_started) {
            delete feature.just_started;
          }
          statusFields.forEach((name) => {
            if (feature[name] !== oldStatus[feature.slug][name]) {
              feature.updated[name] = {
                from: oldStatus[feature.slug][name],
                to: feature[name],
              };
            }
          });
        }
      });
    }).catch((err) => {
      console.error('ERROR:', err);
    })
    .then(() => features)
  );
}

// `status` key holds an Object representation of `status.json`
// `changed` is a hashtag with just changed data stored by date
function saveData(features, dbTestNumber) {
  // store changes under date
  const date = new Date().toISOString();
  const statusData = {};
  const changedData = {
    updated: {},
    started: [],
  };
  let isChanged = false;
  features.forEach((feature) => {
    statusData[feature.slug] = feature;
    if (Object.keys(feature.updated).length > 0) {
      isChanged = true;
      changedData.updated[feature.slug] = feature.updated;
    }
    if (feature.just_started) {
      isChanged = true;
      changedData.started.push(feature);
    }
  });
  return redis.getClient(dbTestNumber)
  .then(client => redis.set(client, 'status', JSON.stringify(statusData))
    .then(() => {
      if (isChanged) {
        console.log('DEBUG: found new changes');
        return redis.hmset(client, 'changelog', date, JSON.stringify(changedData));
      }
      console.log('DEBUG: no changes found');
    }).catch((err) => {
      console.error('ERROR:', err);
    })
    .then(() => features)
  );
}

function validateFeatureInput(features) {
  // We could potentially use a real JSON schema, but we'd still have to do
  // uniqueness checks ourselves.
  const schema = {
    file: {
      required: true,
      unique: true,
    },
    title: {
      required: true,
      unique: true,
    },
    summary: {
      required: true,
      unique: true,
    },
    slug: {
      required: true,
      unique: true,
    },
    category: {
    },
    bugzilla: {
      required: true,
      unique: true,
    },
    firefox_status: {
      required: true,
    },
    firefox_footnote: {
    },
    mdn_url: {
      required: true,
      unique: true,
    },
    spec_url: {
      required: true,
      unique: true,
    },
    spec_repo: {
    },
    spec_status: {
    },
    chrome_ref: {
      required: true,
      unique: true,
    },
    chrome_status: {
    },
    chrome_footnote: {
    },
    opera_status: {
    },
    opera_footnote: {
    },
    webkit_ref: {
      required: true,
      unique: true,
    },
    webkit_status: {
    },
    webkit_footnote: {
    },
    ie_ref: {
      required: true,
      unique: true,
    },
    ie_status: {
    },
    ie_footnote: {
    },
    caniuse_ref: {
      unique: true,
    },
  };
  const uniques = {};
  features.forEach((feature) => {
    const properties = Object.keys(feature);
    for (const propertyName of properties) {
      if (!(propertyName in schema)) {
        validateWarning(`${feature.file}: unknown property "${propertyName}"`);
      }
    }

    for (const key of Object.keys(schema)) {
      const value = feature[key];

      if (schema[key].required && !value) {
        validateWarning(`${feature.file}: missing required property "${key}"`);
      }

      if (schema[key].unique && typeof value !== 'undefined') {
        if (!(key in uniques)) {
          uniques[key] = {};
        }
        const duplicate = uniques[key][value];
        if (duplicate) {
          validateWarning(`${feature.file}: duplicate value "${value}" for key "${key}", previously defined in ${duplicate}`);
        } else {
          uniques[key][value] = feature.file;
        }
      }
    }
  });
}

let alt = null;
handlebars.registerHelper('alt', (state, field, variance) => {
  if (!alt) {
    alt = JSON.parse(fs.readFileSync('./src/tpl/alt.json'));
  }
  const value = alt[field][state] || null;
  if (!value || typeof variance !== 'string') {
    return value;
  }
  return value[variance];
});

handlebars.registerHelper('if_eq', function comparison(left, right, opts) { // No fat-arrow since we want don't want lexical 'this'
  if (left === right) {
    return opts.fn(this);
  }
  return opts.inverse(this);
});

// status partial
const featureStatusContents = fs.readFileSync('src/tpl/featureStatusPartial.html', {
  encoding: 'utf-8',
});
// links partial is needed as the feature page is built in a slightly different
// way (no summary), we might also switch off links when embedded
const featureLinksContents = fs.readFileSync('src/tpl/featureLinksPartial.html', {
  encoding: 'utf-8',
});

function buildIndex(status) {
  const templateContents = fs.readFileSync('src/tpl/index.html', {
    encoding: 'utf-8',
  });
  handlebars.registerHelper('featureStatusName', function featureStatusName() {
    return `${this.slug}-status`;
  });
  handlebars.registerHelper('featureLinksName', function featureLinksName() {
    return `${this.slug}-links`;
  });
  status.features.forEach((featureData) => {
    // register partials for each feature
    handlebars.registerPartial(
        `${featureData.slug}-status`,
        handlebars.compile(featureStatusContents)(featureData));
    handlebars.registerPartial(
        `${featureData.slug}-links`,
        handlebars.compile(featureLinksContents)(featureData));
  });
  return Promise.resolve(handlebars.compile(templateContents)(status));
}

function buildFeatures(status) {
  const templateContents = fs.readFileSync('src/tpl/feature.html', {
    encoding: 'utf-8',
  });
  return Promise.resolve(status.features.map(feature => {
    handlebars.registerPartial('featureStatus',
        handlebars.compile(featureStatusContents)(feature));
    handlebars.registerPartial('featureLinks',
        handlebars.compile(featureLinksContents)(feature));
    return {
      slug: feature.slug,
      contents: handlebars.compile(templateContents)(feature),
    };
  }));
}

function buildStatus(options) {
  validationWarnings = [];
  return Promise.all([
    fixtureParser.read(),
    browserParser.read(),
    firefoxVersionParser.read(),
    canIUseParser.read(),
  ]).then(() => {
    validateFeatureInput(fixtureParser.results);
    return populateBugzillaData(fixtureParser.results, options);
  }).then(() => {
    populateFirefoxStatus(firefoxVersionParser.results, fixtureParser.results);
    populateBrowserFeatureData(browserParser.results, fixtureParser.results);
    fillInUsingCanIUseData(canIUseParser.results, fixtureParser.results);
    populateSpecStatus(browserParser.results, fixtureParser.results);
    populateCanIUsePercent(canIUseParser.results, fixtureParser.results);
    return checkForNewData(fixtureParser.results);
  }).then(saveData)
  .then(() => {
    const data = {
      created: (new Date()).toISOString(),
      features: fixtureParser.results,
      firefoxVersions: firefoxVersionParser.results,
    };
    if (validationWarnings.length) {
      console.warn('Validation warnings: ');
      validationWarnings.forEach((warning) => {
        console.warn(`\t${warning}`);
      });
    }
    return data;
  });
}

export default {
  buildStatus,
  buildIndex,
  buildFeatures,
};

const test = {
  normalizeStatus,
  saveData,
  checkForNewData,
  buildFeatures,
};
export { test };
