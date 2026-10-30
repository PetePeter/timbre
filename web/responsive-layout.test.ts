// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { Window as HappyWindow } from 'happy-dom';
import { readFileSync } from 'node:fs';

describe('responsive action layout', () => {
  let browser: InstanceType<typeof HappyWindow> | undefined;

  afterEach(async () => {
    await browser?.happyDOM.abort();
    browser = undefined;
  });

  it('wraps actions and keeps form buttons in normal flow at phone width', async () => {
    browser = new HappyWindow({ url: 'http://localhost' });
    await browser.happyDOM.setWindowSize({ width: 390, height: 844 });
    browser.document.head.innerHTML = `<style>${readFileSync('web/style.css', 'utf8')}</style>`;
    browser.document.body.innerHTML = `
      <main class="app-main" style="--savebar-height: 72px">
        <header class="page-heading"><h1>Agent settings</h1><div class="row"><button>Add Claude Code</button></div></header>
        <section class="panel">
          <div class="section-heading"><h2>Local CLI</h2><div class="row"><button>Add</button></div></div>
          <form><div class="row"><input class="grow"><button>Browse</button></div></form>
          <fieldset class="panel stack"><input><div class="row llm-actions"><button>Remove</button></div></fieldset>
        </section>
      </main>
      <footer class="savebar"><span class="grow">Unsaved changes</span><button>Discard</button><button>Save</button></footer>`;

    const style = (selector: string) => browser!.getComputedStyle(browser!.document.querySelector(selector)!);
    expect(browser.innerWidth).toBe(390);
    expect(style('.page-heading').flexWrap).toBe('wrap');
    expect(style('.section-heading').flexWrap).toBe('wrap');
    expect(style('form .row').flexWrap).toBe('wrap');
    expect(style('.savebar').flexWrap).toBe('wrap');
    expect(style('.app-main').paddingBottom).toBe('calc(74px + 22px + 72px)');
    for (const button of browser.document.querySelectorAll('button')) {
      const position = browser.getComputedStyle(button).position;
      expect(position === '' || position === 'static').toBe(true);
    }
  });
});
