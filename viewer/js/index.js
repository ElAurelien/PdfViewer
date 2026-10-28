import "./polyfill.js";
import {
    GlobalWorkerOptions,
    PasswordResponses,
    TextLayer,
    getDocument,
} from "pdfjs-dist";
import { getSimplifiedOutline } from "./outline.js";

GlobalWorkerOptions.workerSrc = "/viewer/js/worker.js";

let pdfDoc = null;
let outlineAbort = new AbortController();
const container = document.getElementById("container");

let pageViews = [];
// Pages that currently hold a canvas and/or text layer.
const renderedViews = new Set();
// Scale-1 page size (including the document rotation) used for pages not yet loaded.
let defaultBase = { width: 612, height: 792 };
let appliedZoom = 0;
let appliedRotation = 0;
// Incremented on every zoom/rotation change, invalidating all rendered pages and renders in flight.
let layoutGen = 0;

let pumping = false;
let pinching = false;
let activeView = null;
let activeCancel = null;

let reportedPage = 0;
let jumpTargetY = null;
let scrollQueued = false;

let isTextLayerVisible = false;
let userZoomed = false;

function insetsInCssPixels() {
    const ratio = globalThis.devicePixelRatio;
    return {
        left: channel.getInsetLeft() / ratio,
        top: channel.getInsetTop() / ratio,
        right: channel.getInsetRight() / ratio,
        bottom: channel.getInsetBottom() / ratio
    };
}

// Add padding around the pages to allow them to be scrolled below/above any system/app ui that
// might be visible.
function applyInsets() {
    const insets = insetsInCssPixels();
    container.style.paddingLeft = insets.left + "px";
    container.style.paddingTop = insets.top + "px";
    container.style.paddingRight = insets.right + "px";
    container.style.paddingBottom = insets.bottom + "px";
}

function setDefaultBase(width, height) {
    defaultBase = { width, height };
    container.style.setProperty("--base-width", width + "px");
    container.style.setProperty("--base-height", height + "px");
}

function pageTop(pv) {
    return pv.div.getBoundingClientRect().top + globalThis.scrollY;
}

// Index of the last page starting at or above the given document offset.
function findPageAt(y) {
    let lo = 0;
    let hi = pageViews.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (pageTop(pageViews[mid]) <= y) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return lo;
}

function captureAnchor() {
    const y = globalThis.scrollY;
    const pv = pageViews[findPageAt(y)];
    return { pv, fraction: (y - pageTop(pv)) / pv.div.offsetHeight };
}

function restoreAnchor(anchor) {
    const y = pageTop(anchor.pv) + anchor.fraction * anchor.pv.div.offsetHeight;
    globalThis.scrollTo(globalThis.scrollX, y);
}

function setPageBase(pv, width, height) {
    if (pv.baseWidth === width && pv.baseHeight === height) {
        return;
    }
    const heightBefore = pv.div.offsetHeight;
    const bottomBefore = pageTop(pv) + heightBefore;
    pv.baseWidth = width;
    pv.baseHeight = height;
    pv.div.style.setProperty("--base-width", width + "px");
    pv.div.style.setProperty("--base-height", height + "px");
    // Keep the content in view still when a page above it changes size.
    if (bottomBefore <= globalThis.scrollY) {
        globalThis.scrollBy(0, pv.div.offsetHeight - heightBefore);
    }
}

function getFitWidthZoomRatio(baseWidth) {
    const insets = insetsInCssPixels();
    const available = document.body.clientWidth - insets.left - insets.right;
    return Math.max(Math.min(available / baseWidth, channel.getMaxZoomRatio()),
        channel.getMinZoomRatio());
}

function createPageViews(numPages) {
    const views = [];
    const fragment = document.createDocumentFragment();
    for (let i = 1; i <= numPages; i++) {
        const div = document.createElement("div");
        div.className = "page";
        fragment.append(div);
        views.push({
            num: i,
            div,
            canvas: null,
            textDiv: null,
            baseWidth: null,
            baseHeight: null,
            renderedGen: -1,
            failedGen: -1
        });
    }
    container.replaceChildren(fragment);
    return views;
}

function releaseView(pv) {
    if (activeView === pv) {
        cancelActive();
    }
    if (pv.canvas !== null) {
        // Free the bitmap memory right away rather than waiting for garbage collection.
        pv.canvas.width = 0;
        pv.canvas.remove();
        pv.canvas = null;
    }
    if (pv.textDiv !== null) {
        pv.textDiv.remove();
        pv.textDiv = null;
    }
    pv.renderedGen = -1;
    renderedViews.delete(pv);
}

function cancelActive() {
    if (activeCancel !== null) {
        activeCancel();
    }
}

function applyView(zoom, rotation) {
    layoutGen++;
    cancelActive();

    if (rotation !== appliedRotation) {
        if ((rotation - appliedRotation) % 180 !== 0) {
            setDefaultBase(defaultBase.height, defaultBase.width);
            for (const pv of pageViews) {
                if (pv.baseWidth !== null) {
                    const width = pv.baseHeight;
                    pv.baseHeight = pv.baseWidth;
                    pv.baseWidth = width;
                    pv.div.style.setProperty("--base-width", pv.baseWidth + "px");
                    pv.div.style.setProperty("--base-height", pv.baseHeight + "px");
                }
            }
        }
        appliedRotation = rotation;
    }

    appliedZoom = zoom;
    container.style.setProperty("--scale-factor", zoom.toString());

    // Existing text layers no longer match the page until it is rendered again.
    for (const pv of renderedViews) {
        if (pv.textDiv !== null) {
            pv.textDiv.hidden = true;
        }
    }
}

function scrollToPage(pageNumber) {
    const pv = pageViews[pageNumber - 1];
    if (pv === undefined) {
        return;
    }
    globalThis.scrollTo(globalThis.scrollX, pageTop(pv) - insetsInCssPixels().top);
    jumpTargetY = globalThis.scrollY;
    reportedPage = pageNumber;
    updateVisible();
}

function updateCurrentPage() {
    const y = globalThis.scrollY;
    if (jumpTargetY !== null) {
        if (Math.abs(y - jumpTargetY) < 1) {
            return;
        }
        jumpTargetY = null;
    }

    const viewportHeight = globalThis.innerHeight;
    let pageNumber;
    if (y <= 0) {
        pageNumber = 1;
    } else if (y + viewportHeight >= document.documentElement.scrollHeight - 1) {
        pageNumber = pageViews.length;
    } else {
        pageNumber = findPageAt(y + viewportHeight / 2) + 1;
    }
    if (pageNumber !== reportedPage) {
        reportedPage = pageNumber;
        channel.setPage(pageNumber);
    }
}

function updateVisible() {
    if (pageViews.length === 0) {
        return;
    }
    const y = globalThis.scrollY;
    const viewportHeight = globalThis.innerHeight;

    const keepFirst = findPageAt(y - viewportHeight);
    const keepLast = findPageAt(y + viewportHeight * 2);
    for (const pv of renderedViews) {
        if (pv.num - 1 < keepFirst || pv.num - 1 > keepLast) {
            releaseView(pv);
        }
    }

    if (activeView !== null) {
        const wantFirst = findPageAt(y - viewportHeight / 2);
        const wantLast = findPageAt(y + viewportHeight * 1.5);
        if (activeView.num - 1 < wantFirst || activeView.num - 1 > wantLast) {
            cancelActive();
        }
    }

    schedule();
}

function nextViewToRender() {
    const y = globalThis.scrollY;
    const viewportHeight = globalThis.innerHeight;
    const first = findPageAt(y - viewportHeight / 2);
    const last = findPageAt(y + viewportHeight * 1.5);
    const center = y + viewportHeight / 2;

    let best = null;
    let bestDistance = Infinity;
    for (let i = first; i <= last; i++) {
        const pv = pageViews[i];
        if (pv.renderedGen === layoutGen || pv.failedGen === layoutGen) {
            continue;
        }
        const distance = Math.abs(pageTop(pv) + pv.div.offsetHeight / 2 - center);
        if (distance < bestDistance) {
            best = pv;
            bestDistance = distance;
        }
    }
    return best;
}

function schedule() {
    if (!pumping && !pinching) {
        pump();
    }
}

async function pump() {
    pumping = true;
    try {
        while (!pinching) {
            const pv = nextViewToRender();
            if (pv === null) {
                break;
            }
            await renderView(pv);
        }
    } finally {
        pumping = false;
    }
}

async function renderView(pv) {
    const gen = layoutGen;
    const zoom = appliedZoom;
    const rotation = appliedRotation;
    let cancelled = false;
    let current = null;
    activeView = pv;
    activeCancel = () => {
        cancelled = true;
        if (current !== null) {
            current.cancel();
        }
    };

    try {
        const page = await pdfDoc.getPage(pv.num);
        if (cancelled) {
            return;
        }

        const totalRotation = (rotation + page.rotate) % 360;
        const baseViewport = page.getViewport({ scale: 1, rotation: totalRotation });
        setPageBase(pv, baseViewport.width, baseViewport.height);

        const viewport = page.getViewport({ scale: zoom, rotation: totalRotation });
        const ratio = globalThis.devicePixelRatio;
        const renderPixels = viewport.height * ratio * viewport.width * ratio;

        let renderViewport = viewport;
        const maxRenderPixels = channel.getMaxRenderPixels();
        if (renderPixels > maxRenderPixels) {
            console.log(`resolution ${renderPixels} exceeds maximum allowed ${maxRenderPixels}`);
            const adjustedScale = Math.sqrt(maxRenderPixels / renderPixels);
            renderViewport = page.getViewport({
                scale: zoom * adjustedScale,
                rotation: totalRotation
            });
        }

        const newCanvas = document.createElement("canvas");
        newCanvas.height = renderViewport.height * ratio;
        newCanvas.width = renderViewport.width * ratio;
        const context = newCanvas.getContext("2d", { alpha: false });
        context.scale(ratio, ratio);

        const renderTask = page.render({ canvasContext: context, viewport: renderViewport });
        current = renderTask;
        await renderTask.promise;
        if (cancelled) {
            return;
        }

        if (pv.canvas !== null) {
            pv.canvas.width = 0;
            pv.canvas.replaceWith(newCanvas);
        } else {
            pv.div.prepend(newCanvas);
        }
        pv.canvas = newCanvas;
        renderedViews.add(pv);

        const newTextDiv = document.createElement("div");
        newTextDiv.className = "textLayer";
        const textLayer = new TextLayer({
            textContentSource: page.streamTextContent(),
            container: newTextDiv,
            viewport: viewport
        });
        current = { cancel: () => textLayer.cancel() };
        await textLayer.render();
        if (cancelled) {
            return;
        }

        if (pv.textDiv !== null) {
            pv.textDiv.replaceWith(newTextDiv);
        } else {
            pv.div.append(newTextDiv);
        }
        pv.textDiv = newTextDiv;
        pv.renderedGen = gen;
    } catch (error) {
        if (!cancelled) {
            console.log("rendering error: " + error);
            pv.failedGen = gen;
        }
    } finally {
        activeView = null;
        activeCancel = null;
    }
}

function onScroll() {
    scrollQueued = false;
    if (pdfDoc === null || pageViews.length === 0) {
        return;
    }
    updateCurrentPage();
    updateVisible();
}

globalThis.addEventListener("scroll", () => {
    if (!scrollQueued) {
        scrollQueued = true;
        globalThis.requestAnimationFrame(onScroll);
    }
}, { passive: true });

/**
 * @param {number} zoom 0 for any other change (rotation, resize), 1 for a zoom step or the end of
 * a pinch gesture (around the screen center), 2 for a pinch gesture in progress (around the focus
 * point supplied by the channel).
 */
globalThis.onRenderPage = function (zoom) {
    if (pdfDoc === null || pageViews.length === 0) {
        return;
    }
    if (zoom === 1 || zoom === 2) {
        userZoomed = true;
    }
    pinching = zoom === 2;
    applyInsets();

    const newZoom = channel.getZoomRatio();
    const newRotation = channel.getDocumentOrientationDegrees();
    const zoomChanged = newZoom !== appliedZoom;
    const rotationChanged = newRotation !== appliedRotation;

    if (zoomChanged || rotationChanged) {
        const oldZoom = appliedZoom;
        const ratio = globalThis.devicePixelRatio;
        const useFocus = (zoom === 1 || zoom === 2) && !rotationChanged;
        // Focus point relative to the document origin, rather than the screen origin.
        const focusX = (zoom === 2 ? channel.getZoomFocusX() / ratio : globalThis.innerWidth / 2) +
            globalThis.scrollX;
        const focusY = (zoom === 2 ? channel.getZoomFocusY() / ratio : globalThis.innerHeight / 2) +
            globalThis.scrollY;
        const anchor = useFocus ? null : captureAnchor();

        applyView(newZoom, newRotation);

        if (useFocus) {
            const translationFactor = newZoom / oldZoom - 1;
            globalThis.scrollBy(focusX * translationFactor, focusY * translationFactor);
        } else {
            restoreAnchor(anchor);
        }
    }

    jumpTargetY = null;
    updateVisible();
};

globalThis.jumpToPage = function (pageNumber) {
    if (pdfDoc === null || pageViews.length === 0) {
        return;
    }
    scrollToPage(pageNumber);
};

globalThis.isTextSelected = function () {
    return globalThis.getSelection().toString() !== "";
};

globalThis.getDocumentOutline = function () {
    pdfDoc.getOutline().then(function(outline) {
        getSimplifiedOutline(outline, outlineAbort, pdfDoc).then(function(outlineEntries) {
            if (outlineEntries !== null) {
                channel.setDocumentOutline(JSON.stringify(outlineEntries));
            } else {
                channel.setDocumentOutline(null);
            }
        }).catch(function(error) {
            console.log("getSimplifiedOutline error: " + error);
        });
    }).catch(function(error) {
        console.log("pdfDoc.getOutline error: " + error);
    });
};

globalThis.abortDocumentOutline = function () {
    outlineAbort.abort();
    outlineAbort = new AbortController();
};

globalThis.toggleTextLayerVisibility = function () {
    let textLayerForeground = "red";
    if (isTextLayerVisible) {
        textLayerForeground = "transparent";
    }
    document.documentElement.style.setProperty("--text-layer-foreground", textLayerForeground);
    isTextLayerVisible = !isTextLayerVisible;
};

function initPages() {
    const doc = pdfDoc;
    doc.getPage(1).then(function (page) {
        if (doc !== pdfDoc) {
            return;
        }
        const rotation = channel.getDocumentOrientationDegrees();
        const viewport = page.getViewport({ scale: 1, rotation: (rotation + page.rotate) % 360 });

        layoutGen++;
        cancelActive();
        renderedViews.clear();
        appliedRotation = rotation;
        setDefaultBase(viewport.width, viewport.height);

        let zoom = channel.getZoomRatio();
        if (zoom === 0) {
            zoom = getFitWidthZoomRatio(viewport.width);
            channel.setZoomRatio(zoom);
        }
        appliedZoom = zoom;
        container.style.setProperty("--scale-factor", zoom.toString());
        applyInsets();

        pageViews = createPageViews(doc.numPages);
        setPageBase(pageViews[0], viewport.width, viewport.height);
        reportedPage = channel.getPage();
        scrollToPage(reportedPage);
    }).catch(function (error) {
        console.log("initPages error: " + error);
        channel.onLoadError();
    });
}

globalThis.loadDocument = function () {
    userZoomed = false;
    pageViews = [];
    reportedPage = 0;
    jumpTargetY = null;
    const pdfPassword = channel.getPassword();
    const loadingTask = getDocument({
        url: "https://localhost/placeholder.pdf",
        cMapUrl: "https://localhost/viewer/cmaps/",
        cMapPacked: true,
        password: pdfPassword,
        iccUrl: "https://localhost/viewer/iccs/",
        // This flag controls jpx/icc and PostScript Calculator function compiler at the same time.
        // See https://github.com/GrapheneOS/PdfViewer/issues/634#issuecomment-4356820142
        // for security justifications.
        //
        // Note that CSP is only applied to index.html, not workers where WASM runs
        useWasm: true,
        // If a font isn't embedded, the viewer falls back to default system fonts. On Android,
        // there often isn't a good substitution provided by the OS, so we need to bundle standard
        // fonts to improve the rendering of certain PDFs:
        //
        // https://github.com/mozilla/pdf.js/pull/18465
        // https://bugzilla.mozilla.org/show_bug.cgi?id=1882613
        useSystemFonts: false,
        standardFontDataUrl: "https://localhost/viewer/standard_fonts/",
        wasmUrl: "https://localhost/viewer/wasm/"
    });
    loadingTask.onPassword = (_, error) => {
        if (error === PasswordResponses.NEED_PASSWORD) {
            channel.showPasswordPrompt();
        } else if (error === PasswordResponses.INCORRECT_PASSWORD) {
            channel.invalidPassword();
        }
    };

    loadingTask.promise.then(function (newDoc) {
        channel.onLoaded();
        pdfDoc = newDoc;
        channel.setNumPages(pdfDoc.numPages);
        pdfDoc.getMetadata().then(function (data) {
            channel.setDocumentProperties(JSON.stringify(data.info));
        }).catch(function (error) {
            console.log("getMetadata error: " + error);
        });
        pdfDoc.getOutline().then(function(outline) {
            channel.setHasDocumentOutline(outline && outline.length > 0);
        }).catch(function(error) {
            console.log("getOutline error: " + error);
        });
        initPages();
    }, function (reason) {
        console.error(reason.name + ": " + reason.message);
        channel.onLoadError();
    });
};

globalThis.onresize = () => {
    if (pdfDoc === null || pageViews.length === 0) {
        return;
    }
    applyInsets();
    if (userZoomed) {
        updateVisible();
        return;
    }
    const pv = pageViews[Math.max(reportedPage, 1) - 1];
    const width = pv.baseWidth ?? defaultBase.width;
    channel.setZoomRatio(getFitWidthZoomRatio(width));
    globalThis.onRenderPage(0);
};
