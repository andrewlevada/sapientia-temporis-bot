/* eslint-disable @typescript-eslint/no-unused-vars */
import { JSDOM, DOMWindow, CookieJar } from "jsdom";
import axios from "axios";
import beaconPackage from "@andrewlevada/send-beacon";
import { Event, PageViewEvent, UserPropertyUpdated } from "../analytics-service";
import { getUserCookies, setUserCookies } from "./emulator-cookies-service";
import { getBrowserSession, getSessionsNumber,
  getStaleQueueUserId, GtagFunction,
  popFromEmulationRequestsQueue,
  pushToEmulationRequestsQueue,
  removeBrowserSession,
  setBrowserSession } from "./emulator-sessions-storage";

const debugLog = false;
const sessionIdleTime = 10000;

export function emulateSendEvent(event: Event): Promise<void> {
  return emulatePageView({ userId: event.userId, url: `/${event.name}` },
    gtag => new Promise(resolve => {
      setBrowserSession(event.userId, { beaconCallback: resolve });
      if (event.params === undefined) event.params = {};
      event.params.event_timeout = 0;
      gtag("event", event.name, event.params);
    }));
}

export function emulateUserPropertiesUpdate(event: UserPropertyUpdated): Promise<void> {
  return emulatePageView({ userId: event.userId, url: null },
    gtag => new Promise(resolve => {
      setBrowserSession(event.userId, { beaconCallback: undefined });
      event.properties = { ...event.properties, crm_id: event.userId };
      gtag("set", "user_properties", event.properties);
      gtag("get", "G-HYFTVXK74M", "user_properties", resolve);
    }));
}

export function emulatePageView(e: PageViewEvent, callback?: (gtag: GtagFunction)=> Promise<void>): Promise<void> {
  const checkHash = Math.floor(Math.random() * 10000);

  const session = getBrowserSession(e.userId);
  if ((session && session.state !== "idle") || isSessionLimitReached()) {
    if (debugLog) console.log(`emulate view QUEUE ${checkHash}`);
    pushToEmulationRequestsQueue({ callback, event: e });
    return Promise.resolve();
  }
  if (debugLog) console.log(`emulate view start NOW ${checkHash}, ${e.url}`);

  setBrowserSession(e.userId, { state: "updating" });
  return (!session || shouldPageNavigate(e, session.window) ? createNewPage(e) : Promise.resolve()).then(() => {
    if (debugLog) console.log(`emulate view DONE SETUP ${checkHash}`);
    (callback ? callback(getBrowserSession(e.userId)!.gtag!) : Promise.resolve()).then(() => {
      setBrowserSession(e.userId, { state: "idle" });
      if (debugLog) console.log(`emulate view DONE ${checkHash}`);
      if (tryRunQueuedViews(e.userId)) return;
      setBrowserSession(e.userId, { timeout: setTimeout(() => {
        if (getBrowserSession(e.userId)?.state !== "idle") return;
        setBrowserSession(e.userId, { state: "finishing" });
        if (debugLog) console.log(`emulate view TO ${checkHash}`);
        const s = getBrowserSession(e.userId)!;
          s.window!.close();
          setUserCookies(e.userId, JSON.stringify(s.cookieJar!.toJSON())).then(() => {
            removeBrowserSession(e.userId);
            if (!tryRunQueuedViews(e.userId)) tryRunStaleQueuedViews();
          });
      }, sessionIdleTime) });
    });
  });
}

function createNewPage(event: PageViewEvent): Promise<void> {
  const session = getBrowserSession(event.userId);
  const oldCookieJar = session?.cookieJar;
  if (session && session.window) session.window.close();

  return getUserCookies(event.userId).then(cookies => {
    if (!event.url) event.url = "/";
    const { window, cookieJar } = new JSDOM(getHtml(titlesMap[event.url] || "404"), {
      url: constructEmulatedUrl(event), cookieJar: oldCookieJar || (cookies ? CookieJar.fromJSON(cookies) : undefined),
    });

    return axios.get("https://www.googletagmanager.com/gtag/js?id=G-HYFTVXK74M")
      .then(res => res.data as string).then(gtagScript => {
        const { document, navigator } = window;
        const self = window;

        // Here are several hacky patches to make analytics work in JSDom
        Object.defineProperty(document, "visibilityState", {
          get() { return "visible"; },
        });

        navigator.sendBeacon = (url, data) => {
          if (debugLog) console.log("Sending out beacon!");
          beaconPackage(url as string, data);
          const callback = getBrowserSession(event.userId)?.beaconCallback;
          if (callback) callback();
          return true;
        };

        try {
          // eslint-disable-next-line no-eval
          eval(gtagScript);
        } catch (ex) {
          console.error("Exception occurred in analytics while evaling gtag.js");
          console.error(ex);
        }

        window.dataLayer = window.dataLayer || [];
        // eslint-disable-next-line prefer-rest-params
        window.gtag = function gtag() { window.dataLayer.push(arguments); };

        return new Promise<void>(resolve => {
          setBrowserSession(event.userId, { window, gtag: window.gtag, cookieJar, beaconCallback: resolve });

          window.gtag("js", new Date());
          window.gtag("config", "G-HYFTVXK74M", { user_id: event.userId, transport_type: "beacon" });
          window.gtag("set", "user_properties", { crm_id: event.userId });
        }).then();
      });
  });
}

function shouldPageNavigate(event: PageViewEvent, window: DOMWindow | undefined): boolean {
  if (!window) return true;
  return event.url !== null && window.location.pathname !== constructEmulatedUrl(event);
}

function constructEmulatedUrl(event: PageViewEvent): string {
  return `https://bot.analytics${event.url}`;
}

function isSessionLimitReached(): boolean {
  return getSessionsNumber() >= 10;
}

function tryRunStaleQueuedViews(): void {
  if (isSessionLimitReached()) return;
  const userId = getStaleQueueUserId();
  if (!userId) return;
  tryRunQueuedViews(userId);
}

function tryRunQueuedViews(userId: string): boolean {
  if (isSessionLimitReached()) return false;
  const request = popFromEmulationRequestsQueue(userId);
  if (!request) return false;
  emulatePageView(request.event, request.callback).then();
  return true;
}

function getHtml(title: string) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
</head>
<body><p>OK</p></body>
</html>
`;
}

const titlesMap: Record<string, string> = {
  "/start_command": "Добро пожаловать",
  "/help_command": "Помощь",
  "/": "Главный экран",
  "/default": "Главный экран",
  "/settings": "Настройки",
  "/leaderboard_view": "Лидерборд",
  "/timetable_view": "Расписание",
  "/group_change": "Изменение группы",
  "/unrecognized": "Неопознаный текст",
  "/broadcast_response": "Ответ на трансляцию",
  "/feedback_open": "Обратная связь",
  "/feedback_send": "Отправка обратной связи",
  "/notifications": "Уведоиления о заменах",
  "/notifications_change": "Изменение уведомления о заменах",
  "/notifications_time_change": "Изменение времени уведомлений",
};
