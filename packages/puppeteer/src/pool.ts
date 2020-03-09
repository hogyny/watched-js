import * as genericPool from "generic-pool";
import { Browser, Page } from "puppeteer-core";
import { PageRuleOptions, setupPageRules } from "./pageRules";

export type PoolOptions = {
  autostart: boolean;
  min: number;
  max: number;
  timeout: number;
  testOnBorrow: boolean;
};

const defaultPoolOptions: PoolOptions = {
  // should the pool start creating resources, initialize the evictor,
  // etc once the constructor is called.
  autostart: true,
  // minimum number of resources to keep in pool at any given time.
  // If this is set >= max, the pool will silently set the min to equal.
  min: 0,
  max: 5,
  // Number of resources to check each eviction run
  testOnBorrow: true,
  // Browser timeout
  timeout: 30000
};

interface PoolBrowser extends Browser {
  poolIsValid: () => boolean;
}

export type PageOptions = {
  /**
   * Open page in incognito mode.
   * Default: `true`
   */
  incognito?: boolean;
  /**
   * Apply page rules on popups
   */
  applyRulesToPopups?: boolean;
  /**
   * Page rule options. If this is set, setupRules will be called when the
   * page is opened.
   */
  ruleOptions?: PageRuleOptions;
};

const defaultPageOptions: PageOptions = {
  incognito: true,
  applyRulesToPopups: true
};

interface BrowserPool extends genericPool.Pool<PoolBrowser> {
  acquirePage: (options?: PageOptions) => PromiseLike<AcquiredPage>;
  callPage: <T>(
    options: PageOptions | undefined,
    handler: (page: AcquiredPage) => PromiseLike<T>
  ) => PromiseLike<T>;
  getPageContent: (options: PageOptions, url: string) => PromiseLike<string>;
}

interface AcquiredPage extends Page {
  setupRules: (options: PageRuleOptions) => void;
  release: () => PromiseLike<void>;
}

export const createPool = (
  createBrowser: () => Promise<Browser>,
  options?: Partial<PoolOptions>
) => {
  const opts = { ...defaultPoolOptions, ...options };
  const factory = {
    create: async () => {
      const browser = <PoolBrowser>await createBrowser();
      const t = Date.now();
      browser.poolIsValid = () => Date.now() - t < opts.timeout;
      return browser;
    },
    destroy: async (browser: PoolBrowser) => {
      await browser.close();
    },
    validate: async (browser: PoolBrowser) => {
      return browser.poolIsValid();
    }
  };

  const pool = <BrowserPool>genericPool.createPool(factory, opts);

  // This is needed to make automatic app restart work when in development mode
  process.once("SIGTERM", async () => {
    await pool.clear();
    process.kill(process.pid, "SIGTERM");
  });

  pool.acquirePage = async options => {
    const opts = { ...defaultPageOptions, ...options };
    const browser = await pool.acquire();
    const ingocnito = opts.incognito
      ? await browser.createIncognitoBrowserContext()
      : null;

    const page = <AcquiredPage>await (ingocnito ?? browser).newPage();
    const pages = [page];

    page.release = async () => {
      for (const p of pages.reverse()) {
        await p.close();
      }
      if (ingocnito) await ingocnito.close();
      await pool.release(browser);
    };

    page.setupRules = options => setupPageRules(page, options);
    if (opts.ruleOptions) page.setupRules(opts.ruleOptions);

    page.on("popup", async (p: AcquiredPage) => {
      pages.push(p);
      p.setupRules = options => setupPageRules(p, options);
      if (opts.applyRulesToPopups && opts.ruleOptions)
        p.setupRules(opts.ruleOptions);
    });

    return page;
  };

  pool.callPage = async (options, handler) => {
    const page = await pool.acquirePage(options);
    try {
      return await handler(page);
    } finally {
      await page.release();
    }
  };

  pool.getPageContent = async (options, url) => {
    return await pool.callPage(options, async page => {
      await page.goto(url);
      return await page.content();
    });
  };

  return pool;
};