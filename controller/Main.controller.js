sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/ActionSheet",
  "sap/m/Button"
], function (Controller, JSONModel, MessageToast, ActionSheet, Button) {
  "use strict";

  var MONTH_NAMES = ["Januar","Februar","März","April","Mai","Juni",
                     "Juli","August","September","Oktober","November","Dezember"];
  var DAY_HDR   = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  var DAY_SHORT = ["So","Mo","Di","Mi","Do","Fr","Sa"];

  var COL_WORK     = "#4a90d9";
  var COL_VACATION = "#9b59b6";
  var COL_HOLIDAY  = "#aad4f5";
  var COL_EMPTY    = "#e8c84a";

  var WEBHOOK_URL = "WEBHOOK_URL_PLACEHOLDER";
  var TARGET_MINS = 480;

  var TYPE_LABEL = { vacation: "Urlaub", holiday: "Feiertag" };

  return Controller.extend("zeiterfassung.controller.Main", {

    onInit: function () {
      this.getView().setModel(new JSONModel({ selectedDay: null }));

      var oNow = new Date();
      this._year  = oNow.getFullYear();
      this._month = oNow.getMonth();
      this._today = this._isoDate(oNow);
      this._entries = {};

      this._loadTestdata();
    },

    onAfterRendering: function () {
      var oDom = this.getView().getDomRef();
      if (!oDom || oDom._zeBound) return;
      oDom._zeBound = true;
      var that = this;
      oDom.addEventListener("click", function (e) {
        var oCell = e.target.closest("[data-iso]");
        if (oCell) that.onDayPress(oCell.getAttribute("data-iso"));
      });
    },

    // ── Data init ──────────────────────────────────────────────────────────

    _loadTestdata: function () {
      var that = this;
      jQuery.ajax({
        url: "testdata.json",
        dataType: "json",
        success: function (data) {
          that._initFromTestdata(data.entries || []);
          that._renderCalendar();
          that.onDayPress(that._today);
        },
        error: function () {
          that._renderCalendar();
          that.onDayPress(that._today);
        }
      });
    },

    _initFromTestdata: function (aEntries) {
      this._entries = {};
      this._testdataMap = {};
      aEntries.forEach(function (e) {
        this._testdataMap[e.date] = e;
        var oEntry = { type: e.day_type };
        if (e.day_type === "work") {
          oEntry.start    = e.start_hour   != null ? this._decimalToTime(e.start_hour)   : "";
          oEntry.end      = e.end_hour     != null ? this._decimalToTime(e.end_hour)     : "";
          oEntry.duration = e.actual_hours != null ? this._decimalToTime(e.actual_hours) : "";
          oEntry.break    = "";
        }
        this._entries[e.date] = oEntry;
      }, this);
    },

    _getEffectiveEntry: function (sIso) {
      return this._entries[sIso] || null;
    },

    // ── Month navigation ───────────────────────────────────────────────────

    onPrevMonth: function () {
      if (this._month === 0) { this._month = 11; this._year--; }
      else { this._month--; }
      this._renderCalendar();
    },

    onNextMonth: function () {
      if (this._month === 11) { this._month = 0; this._year++; }
      else { this._month++; }
      this._renderCalendar();
    },

    // ── Day click ──────────────────────────────────────────────────────────

    onDayPress: function (sIso) {
      var oDate = this._parseIso(sIso);
      var iDow  = oDate.getDay();
      if (iDow === 0 || iDow === 6) return;

      var oModel = this.getView().getModel();
      var oEntry = this._getEffectiveEntry(sIso);
      var bRO    = !!oEntry && (oEntry.type === "vacation" || oEntry.type === "holiday");
      var sDur   = (oEntry && oEntry.type === "work") ? (oEntry.duration || "") : "";
      var sLabel = DAY_SHORT[iDow] + ", " +
                   String(oDate.getDate()).padStart(2,"0") + ". " +
                   MONTH_NAMES[oDate.getMonth()];

      oModel.setData(Object.assign(oModel.getData(), {
        selectedDay:           sIso,
        selectedDayLabel:      sLabel,
        selectedReadOnly:      bRO,
        selectedDayTypeName:   this._typeName(oEntry),
        selectedStart:         oEntry ? (oEntry.start    || "") : "",
        selectedEnd:           oEntry ? (oEntry.end      || "") : "",
        selectedDuration:      sDur,
        selectedBreak:         oEntry ? (oEntry.break    || "") : "",
        selectedDaySubmitted:  sDur ? this._fmtHours(sDur) + " h" : "0 h",
        selectedDayUnrecorded: sDur ? "0 h" : "8 h"
      }));

      this._updateWeekSummary(sIso);
      this._buildGridHtml();
    },

    onClosePanel: function () {
      // Panel bleibt offen – immer ein Tag ausgewählt
    },

    // ── Panel change handlers ──────────────────────────────────────────────

    onPanelStartChange:    function (e) { this._applyTime("start",    e.getParameter("value")); },
    onPanelEndChange:      function (e) { this._applyTime("end",      e.getParameter("value")); },
    onPanelDurationChange: function (e) { this._applyTime("duration", e.getParameter("value")); },

    // ── Save / Clear ───────────────────────────────────────────────────────

    onSaveDay: function () {
      var oModel = this.getView().getModel();
      var sIso   = oModel.getProperty("/selectedDay");
      if (!sIso) return;

      this._entries[sIso] = {
        type:     "work",
        start:    oModel.getProperty("/selectedStart")    || "",
        end:      oModel.getProperty("/selectedEnd")      || "",
        duration: oModel.getProperty("/selectedDuration") || "",
        break:    oModel.getProperty("/selectedBreak")    || ""
      };

      var sDur = this._entries[sIso].duration;
      oModel.setProperty("/selectedDaySubmitted",  sDur ? this._fmtHours(sDur) + " h" : "0 h");
      oModel.setProperty("/selectedDayUnrecorded", sDur ? "0 h" : "8 h");
      this._updateWeekSummary(sIso);
      this._buildGridHtml();
      MessageToast.show("Gespeichert");

      this._sendPendingWebhooks(sIso);
    },

    _sendPendingWebhooks: function (sSavedIso) {
      var that = this;

      var isComplete = function (sIso) {
        var oE = that._entries[sIso];
        if (!oE) return false;
        return oE.type === "vacation" || oE.type === "holiday" ||
               (oE.type === "work" && !!oE.duration);
      };

      var getActualMins = function (sIso) {
        var oE = that._entries[sIso];
        if (!oE) return 0;
        if (oE.type === "vacation" || oE.type === "holiday") {
          var td = that._testdataMap && that._testdataMap[sIso];
          return td && td.actual_hours != null ? Math.round(td.actual_hours * 60) : TARGET_MINS;
        }
        return oE.duration ? that._toMins(oE.duration) : 0;
      };

      var getTargetMins = function (sIso) {
        var td = that._testdataMap && that._testdataMap[sIso];
        return td && td.target_hours != null ? Math.round(td.target_hours * 60) : TARGET_MINS;
      };

      var sendDay = function (sIso, iCumulMins) {
        var oE    = that._entries[sIso];
        var iDowD = that._parseIso(sIso).getDay();
        jQuery.ajax({
          url:         WEBHOOK_URL,
          method:      "POST",
          contentType: "application/json",
          data: JSON.stringify({
            weekday:      iDowD === 0 ? 6 : iDowD - 1,
            start_hour:   (oE.type === "work" && oE.start) ? that._timeToDecimal(oE.start) : null,
            end_hour:     (oE.type === "work" && oE.end)   ? that._timeToDecimal(oE.end)   : null,
            actual_hours: getActualMins(sIso) / 60,
            target_hours: getTargetMins(sIso) / 60,
            weekly_hours: Math.round(iCumulMins / 60 * 100) / 100
          }),
          error: function () { MessageToast.show("Webhook-Fehler für " + sIso); }
        });
      };

      if (!isComplete(sSavedIso)) return;

      var oSavedEntry = this._entries[sSavedIso];
      if (oSavedEntry && (oSavedEntry.type === "vacation" || oSavedEntry.type === "holiday")) return;

      var oSaved = this._parseIso(sSavedIso);
      var iDow   = oSaved.getDay();

      for (var i = 1; i < iDow; i++) {
        var oPrev = new Date(oSaved.getFullYear(), oSaved.getMonth(), oSaved.getDate() - i);
        if (!isComplete(this._isoDate(oPrev))) return;
      }

      // Cumulative mins from Monday up to and including saved day
      var iCumulMins = 0;
      for (var j = iDow - 1; j >= 1; j--) {
        var oPrevDay = new Date(oSaved.getFullYear(), oSaved.getMonth(), oSaved.getDate() - j);
        iCumulMins += getActualMins(this._isoDate(oPrevDay));
      }
      iCumulMins += getActualMins(sSavedIso);
      sendDay(sSavedIso, iCumulMins);

      for (var k = 1; iDow + k <= 5; k++) {
        var oNext    = new Date(oSaved.getFullYear(), oSaved.getMonth(), oSaved.getDate() + k);
        var sNextIso = this._isoDate(oNext);
        if (!isComplete(sNextIso)) break;
        iCumulMins += getActualMins(sNextIso);
        sendDay(sNextIso, iCumulMins);
      }
    },

    _timeToDecimal: function (sTime) {
      if (!sTime || !this._isValid(sTime)) return null;
      var p = sTime.split(":");
      return +p[0] + Math.round(+p[1] / 60 * 100) / 100;
    },

    onClearDay: function () {
      var oModel = this.getView().getModel();
      var sIso   = oModel.getProperty("/selectedDay");
      if (!sIso) return;

      var oExist = this._entries[sIso];
      if (!oExist || oExist.type === "holiday" || oExist.type === "vacation") return;

      delete this._entries[sIso];
      oModel.setData(Object.assign(oModel.getData(), {
        selectedStart: "", selectedEnd: "", selectedDuration: "", selectedBreak: "",
        selectedDaySubmitted: "0 h", selectedDayUnrecorded: "8 h"
      }));
      this._updateWeekSummary(sIso);
      this._buildGridHtml();
    },

    // ── Calendar rendering ─────────────────────────────────────────────────

    _renderCalendar: function () {
      var oModel = this.getView().getModel();
      oModel.setProperty("/monthTitle", MONTH_NAMES[this._month]);
      oModel.setProperty("/yearTitle",  String(this._year));
      this._buildGridHtml();
      var sKeep = oModel.getProperty("/selectedDay");
      this._updateWeekSummary(sKeep || this._today);
    },

    _buildGridHtml: function () {
      var oModel    = this.getView().getModel();
      var sSelected = oModel.getProperty("/selectedDay");
      var iYear     = this._year;
      var iMonth    = this._month;

      var iDays     = new Date(iYear, iMonth + 1, 0).getDate();
      var iFirstDow = new Date(iYear, iMonth, 1).getDay();
      var iOffset   = iFirstDow === 0 ? 6 : iFirstDow - 1;

      var parts = ['<div class="zeGrid">'];

      parts.push('<div class="zeGridRow zeGridHdr">');
      parts.push('<div class="zeWkCell zeWkHdr"></div>');
      DAY_HDR.forEach(function (d) {
        parts.push('<div class="zeGridCell zeHdrCell">' + d + '</div>');
      });
      parts.push('</div>');

      var iDay = 1, iRow = 0;
      while (iDay <= iDays) {
        var iRowStart = iDay;
        var iCol0     = iRow === 0 ? iOffset : 0;
        var iWk       = this._isoWeek(new Date(iYear, iMonth, iDay));

        parts.push('<div class="zeGridRow">');
        parts.push('<div class="zeWkCell">' + iWk + '</div>');

        for (var e = 0; e < iCol0; e++) parts.push('<div class="zeGridCell"></div>');

        for (var col = iCol0; col < 7 && iDay <= iDays; col++) {
          var oD     = new Date(iYear, iMonth, iDay);
          var iDow   = oD.getDay();
          var bWe    = iDow === 0 || iDow === 6;
          var sIso   = this._isoDate(oD);
          var bToday = sIso === this._today;
          var bSel   = sIso === sSelected;
          var oE     = this._getEffectiveEntry(sIso);
          var bFuture = sIso > this._today;

          var cls = "zeGridCell zeDay" + (bWe ? " zeWe" : "") + (bToday ? " zeToday" : "") + (bSel ? " zeSel" : "");
          var sAttr = bWe ? "" : ' data-iso="' + sIso + '"';
          parts.push('<div class="' + cls + '"' + sAttr + '>');
          parts.push('<div class="zeDayNum">' + iDay + '</div>');
          if (!bWe) {
            var sColor = this._barColor(oE, bFuture);
            if (sColor) {
              parts.push('<div class="zeDayBar" style="background:' + sColor + '"></div>');
              parts.push('<div class="zeDayVal">' + this._barVal(oE) + '</div>');
            }
          }
          parts.push('</div>');
          iDay++;
        }

        var iUsed = iCol0 + (iDay - iRowStart);
        for (var f = iUsed; f < 7; f++) parts.push('<div class="zeGridCell"></div>');
        parts.push('</div>');
        iRow++;
      }

      parts.push('</div>');
      oModel.setProperty("/calGridHtml", parts.join(""));
    },

    _barColor: function (oE, bFuture) {
      if (!oE && bFuture)                       return null;
      if (!oE)                                  return COL_EMPTY;
      if (oE.type === "vacation")               return COL_VACATION;
      if (oE.type === "holiday")                return COL_HOLIDAY;
      if (oE.type === "work" && oE.duration)    return COL_WORK;
      if (oE.type === "work" && bFuture)        return null;
      return COL_EMPTY;
    },

    _barVal: function (oE) {
      if (!oE)                               return "0";
      if (oE.type === "vacation")            return "8";
      if (oE.type === "holiday")             return "8";
      if (oE.type === "work" && oE.duration) return this._fmtHours(oE.duration);
      return "0";
    },

    // ── Statistics ─────────────────────────────────────────────────────────

    _calcPeriodStats: function (aDates) {
      var iMins = 0, iTargetMins = 0;
      aDates.forEach(function (sIso) {
        var oE = this._getEffectiveEntry(sIso);
        iTargetMins += TARGET_MINS;
        if (!oE) return;
        if (oE.type === "work" && oE.duration) iMins += this._toMins(oE.duration);
        else if (oE.type === "vacation" || oE.type === "holiday") iMins += TARGET_MINS;
      }, this);

      var iUnrec = Math.max(0, iTargetMins - iMins);
      var iOver  = Math.max(0, iMins - iTargetMins);
      var sUnrec = iUnrec > 0
        ? this._fmtMins(iUnrec) + " h"
        : (iOver > 0 ? "+" + this._fmtMins(iOver) + " h" : "0 h");

      var fRatio    = iTargetMins > 0 ? iMins / iTargetMins : 1;
      var sActClass = fRatio >= 1 ? "zeStatsTileValueGreen"
                    : fRatio >= 0.95 ? "zeStatsTileValueOrange"
                    : "zeStatsTileValueRed";

      return {
        actual:     this._fmtMins(iMins) + " h",
        target:     this._fmtMins(iTargetMins) + " h",
        unrecorded: sUnrec,
        balance:    String(iUnrec - iOver),
        actClass:   sActClass
      };
    },

    _weekdayDates: function (oRefDate, iWk) {
      var aDates = [];
      for (var delta = -6; delta <= 6; delta++) {
        var oD = new Date(oRefDate.getFullYear(), oRefDate.getMonth(), oRefDate.getDate() + delta);
        if (this._isoWeek(oD) !== iWk) continue;
        var iDow = oD.getDay();
        if (iDow === 0 || iDow === 6) continue;
        aDates.push(this._isoDate(oD));
      }
      return aDates;
    },

    _updateWeekSummary: function (sRefIso) {
      var oModel   = this.getView().getModel();
      var oRefDate = sRefIso ? this._parseIso(sRefIso) : new Date();
      var iWk      = this._isoWeek(oRefDate);
      var oStats   = this._calcPeriodStats(this._weekdayDates(oRefDate, iWk));

      oModel.setProperty("/currentWeek",       String(iWk));
      oModel.setProperty("/weekActual",         oStats.actual);
      oModel.setProperty("/weekTarget",         oStats.target);
      oModel.setProperty("/weekUnrecorded",     oStats.unrecorded);
      oModel.setProperty("/weekUnrecordedNum",  oStats.balance);
      oModel.setProperty("/weekActualClass",    oStats.actClass);

      this._updateMonthSummary();
    },

    _updateMonthSummary: function () {
      var oModel  = this.getView().getModel();
      var iDays   = new Date(this._year, this._month + 1, 0).getDate();
      var aDates  = [];
      for (var i = 1; i <= iDays; i++) {
        var oD   = new Date(this._year, this._month, i);
        var iDow = oD.getDay();
        if (iDow === 0 || iDow === 6) continue;
        aDates.push(this._isoDate(oD));
      }

      var oStats = this._calcPeriodStats(aDates);
      oModel.setProperty("/monthActual",        oStats.actual);
      oModel.setProperty("/monthTarget",        oStats.target);
      oModel.setProperty("/monthUnrecorded",    oStats.unrecorded);
      oModel.setProperty("/monthUnrecordedNum", oStats.balance);
    },

    // ── Panel time calculation ─────────────────────────────────────────────

    _applyTime: function (sField, sRaw) {
      var oModel = this.getView().getModel();
      var sNorm  = this._normalise(sRaw);
      if (sField === "start")    oModel.setProperty("/selectedStart",    sNorm);
      if (sField === "end")      oModel.setProperty("/selectedEnd",      sNorm);
      if (sField === "duration") oModel.setProperty("/selectedDuration", sNorm);

      var sS = oModel.getProperty("/selectedStart")    || "";
      var sE = oModel.getProperty("/selectedEnd")      || "";
      var sD = oModel.getProperty("/selectedDuration") || "";
      var bS = this._isValid(sS), bE = this._isValid(sE), bD = this._isValid(sD);

      if (sField === "start" || sField === "end") {
        if (bS && bE) {
          var d = this._toMins(sE) - this._toMins(sS);
          if (d >= 0) oModel.setProperty("/selectedDuration", this._toTime(d));
        } else if (sField === "start" && bS && bD) {
          oModel.setProperty("/selectedEnd", this._toTime(this._toMins(sS) + this._toMins(sD)));
        } else if (sField === "end" && bE && bD) {
          var s = this._toMins(sE) - this._toMins(sD);
          if (s >= 0) oModel.setProperty("/selectedStart", this._toTime(s));
        }
      } else {
        if (bS && bD) oModel.setProperty("/selectedEnd", this._toTime(this._toMins(sS) + this._toMins(sD)));
        else if (bE && bD) {
          var s2 = this._toMins(sE) - this._toMins(sD);
          if (s2 >= 0) oModel.setProperty("/selectedStart", this._toTime(s2));
        }
      }
    },

    // ── Theme switcher ─────────────────────────────────────────────────────

    onThemePress: function (oEvent) {
      if (!this._oThemeSheet) {
        var aThemes = [
          { text: "Morning Horizon (Hell)",      theme: "sap_horizon"       },
          { text: "Evening Horizon (Dunkel)",    theme: "sap_horizon_dark"  },
          { text: "High Contrast Schwarz",       theme: "sap_horizon_hcb"   },
          { text: "High Contrast Weiß",          theme: "sap_horizon_hcw"   }
        ];
        this._oThemeSheet = new ActionSheet({
          title: "Design wählen",
          buttons: aThemes.map(function (o) {
            return new Button({
              text: o.text,
              press: function () { sap.ui.getCore().applyTheme(o.theme); }
            });
          })
        });
        this.getView().addDependent(this._oThemeSheet);
      }
      this._oThemeSheet.openBy(oEvent.getSource());
    },

    // ── Helpers ────────────────────────────────────────────────────────────

    _typeName: function (oEntry) {
      return oEntry ? (TYPE_LABEL[oEntry.type] || "") : "";
    },

    _fmtHours: function (sTime) {
      if (!this._isValid(sTime)) return "0";
      var f = this._toMins(sTime) / 60;
      var r = Math.round(f * 10) / 10;
      return r % 1 === 0 ? String(Math.round(r)) : String(r);
    },

    _fmtMins: function (iMins) {
      var h = Math.floor(iMins / 60), m = iMins % 60;
      return m === 0 ? String(h) : h + ":" + String(m).padStart(2, "0");
    },

    _normalise: function (s) {
      if (!s) return "";
      s = s.trim();
      if (/^\d{1,3}:\d{2}$/.test(s)) {
        var p = s.split(":"), h = +p[0], m = +p[1];
        if (h >= 0 && h <= 48 && m >= 0 && m < 60)
          return String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0");
      }
      if (/^\d{3,4}$/.test(s)) {
        var m2 = +s.slice(-2), h2 = +s.slice(0,-2);
        if (h2 >= 0 && h2 <= 48 && m2 >= 0 && m2 < 60)
          return String(h2).padStart(2,"0") + ":" + String(m2).padStart(2,"0");
      }
      return "";
    },

    _isValid:       function (s) { return !!s && /^\d{1,3}:\d{2}$/.test(s); },
    _toMins:        function (s) { var p = s.split(":"); return +p[0]*60 + +p[1]; },
    _toTime:        function (m) { return String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0"); },
    _decimalToTime: function (f) {
      var h = Math.floor(f), m = Math.round((f-h)*60);
      if (m === 60) { h++; m = 0; }
      return String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0");
    },
    _isoDate:  function (d) {
      return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
    },
    _parseIso: function (s) { var p=s.split("-"); return new Date(+p[0],+p[1]-1,+p[2]); },
    _isoWeek:  function (d) {
      var u = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      var day = u.getUTCDay() || 7;
      u.setUTCDate(u.getUTCDate() + 4 - day);
      var ys = new Date(Date.UTC(u.getUTCFullYear(), 0, 1));
      return Math.ceil(((u - ys) / 86400000 + 1) / 7);
    }
  });
});
