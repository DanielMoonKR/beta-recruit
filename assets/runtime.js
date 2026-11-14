/*
 * 땡큐캠핑 베타 모집 페이지 - 정적 배포용 미니 런타임
 * - index.html 의 <template id="dc-template"> 를 화면에 그리고,
 * - Component(renderVals) 값으로 {{...}}, <sc-if>, <sc-for> 를 채운 뒤,
 * - 상태가 바뀔 때마다 morphdom 으로 바뀐 부분만 갱신합니다.
 */
(function () {
  'use strict';

  // ---- 컴포넌트 기반 클래스 -------------------------------------------------
  function DCLogic(props) {
    this.props = props || {};
    this.state = {};
  }
  DCLogic.prototype.setState = function (patch) {
    var next = typeof patch === 'function' ? patch(this.state, this.props) : patch;
    if (!next) return;
    if (!this.__prevState) this.__prevState = Object.assign({}, this.state);
    Object.assign(this.state, next);
    if (this.__schedule) this.__schedule();
  };
  window.DCLogic = DCLogic;

  // ---- 값 찾기 ---------------------------------------------------------------
  var HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
  function lookup(scope, path) {
    path = path.trim();
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (path === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    var parts = path.split('.');
    var cur = scope;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fill(text, scope) {
    return text.replace(HOLE, function (_, p) {
      var v = lookup(scope, p);
      return v == null ? '' : String(v);
    });
  }

  // ---- 템플릿 → HTML 문자열 ---------------------------------------------------
  var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, source: 1, track: 1, wbr: 1 };
  var BOOL = { disabled: 1, checked: 1, hidden: 1, open: 1, readonly: 1, required: 1, selected: 1, multiple: 1, autoplay: 1, muted: 1, loop: 1, playsinline: 1 };
  var EVENT = /^on[A-Z]/; // React 스타일 이벤트 속성
  var handlers = [];

  function attrName(name) {
    // React 스타일 속성 이름을 HTML 이름으로
    var map = { classname: 'class', htmlfor: 'for', autocomplete: 'autocomplete', inputmode: 'inputmode', playsinline: 'playsinline', autoplay: 'autoplay' };
    var low = name.toLowerCase();
    return map[low] || name;
  }

  function renderNodes(nodes, scope, out) {
    for (var i = 0; i < nodes.length; i++) renderNode(nodes[i], scope, out);
  }

  function renderNode(node, scope, out) {
    if (node.nodeType === 3) { // 텍스트
      out.push(esc(fill(node.nodeValue, scope)));
      return;
    }
    if (node.nodeType !== 1) return;
    var tag = node.tagName.toLowerCase();

    if (tag === 'sc-if') {
      var raw = node.getAttribute('value') || '';
      var m = /\{\{\s*([^}]+?)\s*\}\}/.exec(raw);
      var val = m ? lookup(scope, m[1]) : raw;
      if (val) renderNodes(node.childNodes, scope, out);
      return;
    }
    if (tag === 'sc-for') {
      var lm = /\{\{\s*([^}]+?)\s*\}\}/.exec(node.getAttribute('list') || '');
      var list = lm ? lookup(scope, lm[1]) : null;
      var as = node.getAttribute('as') || 'item';
      if (list && list.length) {
        for (var k = 0; k < list.length; k++) {
          var child = Object.create(scope);
          child[as] = list[k];
          renderNodes(node.childNodes, child, out);
        }
      }
      return;
    }

    out.push('<' + tag);
    var attrs = node.attributes;
    var events = [];
    for (var a = 0; a < attrs.length; a++) {
      var name = attrs[a].name;
      var value = attrs[a].value;
      if (/^hint-/.test(name)) continue;
      // 이벤트: 원래 대소문자가 사라지므로 on 으로 시작하는 모든 속성을 이벤트로 처리
      if (/^on/.test(name) && /\{\{/.test(value)) {
        var hm = /\{\{\s*([^}]+?)\s*\}\}/.exec(value);
        var fn = hm ? lookup(scope, hm[1]) : null;
        if (typeof fn === 'function') {
          var id = handlers.push(fn) - 1;
          events.push(name.slice(2).toLowerCase() + ':' + id);
        }
        continue;
      }
      var single = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(value.trim());
      var lname = attrName(name);
      if (single) {
        var v = lookup(scope, single[1]);
        if (BOOL[lname.toLowerCase()]) { if (v && v !== 'false') out.push(' ' + lname); continue; }
        if (v == null || v === false) continue;
        out.push(' ' + lname + '="' + esc(v) + '"');
      } else {
        out.push(' ' + lname + '="' + esc(fill(value, scope)) + '"');
      }
    }
    if (events.length) out.push(' data-on="' + events.join(' ') + '"');
    out.push('>');
    if (VOID[tag]) return;
    var kids = tag === 'template' ? node.content.childNodes : node.childNodes;
    renderNodes(kids, scope, out);
    out.push('</' + tag + '>');
  }

  // ---- 이벤트 위임 -------------------------------------------------------------
  function wrapEvent(e, el) {
    return {
      nativeEvent: e,
      type: e.type,
      target: e.target,
      currentTarget: el,
      clientX: e.clientX,
      clientY: e.clientY,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      button: e.button,
      key: e.key,
      preventDefault: function () { e.preventDefault(); },
      stopPropagation: function () { e.stopPropagation(); }
    };
  }
  function findHandler(el, type, root) {
    while (el && el !== root.parentNode) {
      if (el.nodeType === 1) {
        var spec = el.getAttribute('data-on');
        if (spec) {
          var parts = spec.split(' ');
          for (var i = 0; i < parts.length; i++) {
            var p = parts[i].split(':');
            if (p[0] === type) return { el: el, fn: handlers[+p[1]] };
          }
        }
      }
      el = el.parentNode;
    }
    return null;
  }
  function bindEvents(root) {
    var bubbling = ['click', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'keydown', 'change', 'input'];
    bubbling.forEach(function (type) {
      root.addEventListener(type, function (e) {
        var h = findHandler(e.target, type, root);
        if (h) h.fn(wrapEvent(e, h.el));
      });
    });
    // 캡처 단계 클릭 (끌어서 넘긴 직후의 클릭 막기)
    root.addEventListener('click', function (e) {
      var h = findHandler(e.target, 'clickcapture', root);
      if (h) h.fn(wrapEvent(e, h.el));
    }, true);
    // mouseenter / mouseleave 는 버블링되지 않으므로 캡처로 받음
    ['mouseenter', 'mouseleave'].forEach(function (type) {
      root.addEventListener(type, function (e) {
        var el = e.target;
        if (!el || el.nodeType !== 1) return;
        var spec = el.getAttribute('data-on');
        if (!spec) return;
        spec.split(' ').forEach(function (s) {
          var p = s.split(':');
          if (p[0] === type) handlers[+p[1]](wrapEvent(e, el));
        });
      }, true);
    });
  }

  // ---- 시작 ------------------------------------------------------------------------
  window.mountDC = function (opts) {
    var tpl = document.getElementById(opts.template);
    var root = document.getElementById(opts.root);
    var props = {};
    Object.keys(opts.props || {}).forEach(function (k) {
      if (k.charAt(0) === '$') return;
      var d = opts.props[k];
      props[k] = d && typeof d === 'object' && 'default' in d ? d.default : d;
    });
    var comp = new opts.Component(props);
    if (!comp.state) comp.state = {};
    var pending = false;
    var mounted = false;

    function render() {
      pending = false;
      handlers = [];
      var vals = comp.renderVals();
      var out = [];
      renderNodes(tpl.content.childNodes, vals, out);
      var next = document.createElement('div');
      next.id = root.id;
      next.innerHTML = out.join('');
      window.morphdom(root, next, {
        onBeforeElUpdated: function (fromEl, toEl) {
          if (fromEl.tagName === 'DETAILS') toEl.open = fromEl.open; // FAQ·아코디언 열림 상태 유지
          return true;
        }
      });
      var prevState = comp.__prevState || comp.state;
      comp.__prevState = null;
      if (!mounted) {
        mounted = true;
        if (comp.componentDidMount) comp.componentDidMount();
      } else if (comp.componentDidUpdate) {
        comp.componentDidUpdate(comp.props, prevState);
      }
    }
    comp.__schedule = function () {
      if (pending) return;
      pending = true;
      (window.requestAnimationFrame || setTimeout)(render);
    };
    bindEvents(root);
    render();
    return comp;
  };
})();
