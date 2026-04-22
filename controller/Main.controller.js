sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/ActionSheet",
  "sap/m/Button"
], function (Controller, JSONModel, MessageToast, ActionSheet, Button) {
  "use strict";

  // Array: German month names (index 0 = January)
  var aMonthNames = ["Januar","Februar","März","April","Mai","Juni",
                     "Juli","August","September","Oktober","November","Dezember"];

  // Array: Weekday header labels for the calendar grid (Monday-first)
  var aWeekdayHeaders = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

  // Array: Short German weekday labels (Sunday = index 0, matching JS Date.getDay())
  var aWeekdayShort = ["So","Mo","Di","Mi","Do","Fr","Sa"];

  // String: Color hex values for the day bar indicators
  var sColorWork     = "#4a90d9"; // Blue  – recorded work day
  var sColorVacation = "#9b59b6"; // Purple – vacation day
  var sColorHoliday  = "#aad4f5"; // Light blue – public holiday
  var sColorMissing  = "#e8c84a"; // Yellow – past day without an entry

  // String: Target URL for outgoing webhooks (replace placeholder before deployment)
  var sWebhookUrl = "WEBHOOK_URL_PLACEHOLDER";

  // Object: Display labels for special day types
  var oDayTypeLabels = { vacation: "Urlaub", holiday: "Feiertag" };

  return Controller.extend("zeiterfassung.controller.Main", {

    // ── Initialization ─────────────────────────────────────────────────────

    onInit: function () {
      this.getView().setModel(new JSONModel({ selectedDay: null }));

      var oToday         = new Date();
      this._iYear        = oToday.getFullYear();  // Integer: currently displayed year
      this._iMonth       = oToday.getMonth();     // Integer: currently displayed month (0–11)
      this._sTodayIso    = this._isoDate(oToday); // String: today's date as ISO string (YYYY-MM-DD)
      this._oEntries     = {};                    // Object: all saved day entries, keyed by ISO date

      this._loadTestData();
    },

    onAfterRendering: function () {
      var oDomRef = this.getView().getDomRef();
      if (!oDomRef || oDomRef._zeBound) return;
      oDomRef._zeBound = true;
      var that = this;
      // Click delegation: identify the clicked day cell by its data-iso attribute
      oDomRef.addEventListener("click", function (oEvent) {
        var oCell = oEvent.target.closest("[data-iso]");
        if (oCell) that.onDaySelect(oCell.getAttribute("data-iso"));
      });
    },

    // ── Test data ──────────────────────────────────────────────────────────

    _loadTestData: function () {
      var that = this;
      jQuery.ajax({
        url:      "testdata.json",
        dataType: "json",
        success: function (oResponse) {
          that._aAllUsersData = oResponse.users || [oResponse];
          that._loadUser(that._aAllUsersData[0]);
          that._refreshCalendar();
          that.onDaySelect(that._sTodayIso);
        },
        error: function () {
          that._refreshCalendar();
          that.onDaySelect(that._sTodayIso);
        }
      });
    },

    _loadUser: function (oUserData) {
      var aEntries = oUserData.entries || [];
      this._sUserId = oUserData.user_id || "";

      this._iDefaultTargetMinutes = 480;
      for (var i = 0; i < aEntries.length; i++) {
        if (aEntries[i].day_type === "work" && aEntries[i].target_hours != null) {
          this._iDefaultTargetMinutes = Math.round(aEntries[i].target_hours * 60);
          break;
        }
      }

      this._applyTestData(aEntries);

      var oBtn = this.byId("userBtn");
      if (oBtn) oBtn.setText(oUserData.user_id || "");
    },

    onUserPress: function (oEvent) {
      if (!this._aAllUsersData) return;
      var that = this;
      if (this._oUserSheet) {
        this._oUserSheet.destroy();
        this._oUserSheet = null;
      }
      this._oUserSheet = new ActionSheet({
        title: "Select User",
        buttons: this._aAllUsersData.map(function (oUser) {
          return new Button({
            text:  oUser.user_id,
            press: function () {
              that._loadUser(oUser);
              that._refreshCalendar();
              that.onDaySelect(that._sTodayIso);
            }
          });
        })
      });
      this.getView().addDependent(this._oUserSheet);
      this._oUserSheet.openBy(oEvent.getSource());
    },

    _applyTestData: function (aRawEntries) {
      this._oEntries     = {};
      this._oTestDataMap = {}; // Object: raw entries from testdata.json, keyed by ISO date

      aRawEntries.forEach(function (oRaw) {
        this._oTestDataMap[oRaw.date] = oRaw;

        var oEntry = { type: oRaw.day_type };
        if (oRaw.day_type === "work") {
          oEntry.start    = oRaw.start_hour   != null ? this._decimalToTime(oRaw.start_hour)   : "";
          oEntry.end      = oRaw.end_hour     != null ? this._decimalToTime(oRaw.end_hour)     : "";
          oEntry.duration = oRaw.actual_hours != null ? this._decimalToTime(oRaw.actual_hours) : "";
          oEntry.break    = "";
        }
        this._oEntries[oRaw.date] = oEntry;
      }, this);
    },

    _getEntryForDate: function (sIsoDate) {
      return this._oEntries[sIsoDate] || null;
    },

    // ── Month navigation ───────────────────────────────────────────────────

    onPrevMonth: function () {
      if (this._iMonth === 0) { this._iMonth = 11; this._iYear--; }
      else { this._iMonth--; }
      this._refreshCalendar();
    },

    onNextMonth: function () {
      if (this._iMonth === 11) { this._iMonth = 0; this._iYear++; }
      else { this._iMonth++; }
      this._refreshCalendar();
    },

    // ── Day selection ──────────────────────────────────────────────────────

    onDaySelect: function (sIsoDate) {
      var oDate      = this._parseIso(sIsoDate);
      var iWeekday   = oDate.getDay(); // Integer: 0 = Sunday, 6 = Saturday
      if (iWeekday === 0 || iWeekday === 6) return; // skip weekends

      var oModel     = this.getView().getModel();
      var oEntry     = this._getEntryForDate(sIsoDate);
      var bReadOnly  = !!oEntry && (oEntry.type === "vacation" || oEntry.type === "holiday");
      var sDuration  = (oEntry && oEntry.type === "work") ? (oEntry.duration || "") : "";
      var sTargetStr = this._formatMinutes(this._getTargetMinutesForDate(sIsoDate)) + " h";

      // String: human-readable day label, e.g. "Mo, 07. April"
      var sDayLabel  = aWeekdayShort[iWeekday] + ", " +
                       String(oDate.getDate()).padStart(2, "0") + ". " +
                       aMonthNames[oDate.getMonth()];

      oModel.setData(Object.assign(oModel.getData(), {
        selectedDay:           sIsoDate,
        selectedDayLabel:      sDayLabel,
        selectedReadOnly:      bReadOnly,
        selectedDayTypeName:   this._getDayTypeLabel(oEntry),
        selectedStart:         oEntry ? (oEntry.start    || "") : "",
        selectedEnd:           oEntry ? (oEntry.end      || "") : "",
        selectedDuration:      sDuration,
        selectedBreak:         oEntry ? (oEntry.break    || "") : "",
        selectedDaySubmitted:  sDuration ? this._formatHours(sDuration) + " h" : "0 h",
        selectedDayUnrecorded: sDuration ? "0 h" : sTargetStr
      }));

      this._refreshWeekSummary(sIsoDate);
      this._buildCalendarGrid();
    },

    onClosePanel: function () {
      // Panel stays open – a day is always selected
    },

    // ── Time field change handlers ─────────────────────────────────────────

    onPanelStartChange:    function (oEvent) { this._applyTimeField("start",    oEvent.getParameter("value")); },
    onPanelEndChange:      function (oEvent) { this._applyTimeField("end",      oEvent.getParameter("value")); },
    onPanelDurationChange: function (oEvent) { this._applyTimeField("duration", oEvent.getParameter("value")); },

    // ── Save / Delete ──────────────────────────────────────────────────────

    onSaveDay: function () {
      var oModel   = this.getView().getModel();
      var sIsoDate = oModel.getProperty("/selectedDay");
      if (!sIsoDate) return;

      this._oEntries[sIsoDate] = {
        type:     "work",
        start:    oModel.getProperty("/selectedStart")    || "",
        end:      oModel.getProperty("/selectedEnd")      || "",
        duration: oModel.getProperty("/selectedDuration") || "",
        break:    oModel.getProperty("/selectedBreak")    || ""
      };

      var sDuration = this._oEntries[sIsoDate].duration;
      var sTargetStr = this._formatMinutes(this._getTargetMinutesForDate(sIsoDate)) + " h";
      oModel.setProperty("/selectedDaySubmitted",  sDuration ? this._formatHours(sDuration) + " h" : "0 h");
      oModel.setProperty("/selectedDayUnrecorded", sDuration ? "0 h" : sTargetStr);
      this._refreshWeekSummary(sIsoDate);
      this._buildCalendarGrid();
      MessageToast.show("Gespeichert");

      this._sendPendingWebhooks(sIsoDate);
    },

    _sendPendingWebhooks: function (sSavedIso) {
      var that = this;

      // Returns true if the day has a complete entry (work with duration, vacation, or holiday)
      var isDayComplete = function (sIsoDate) {
        var oEntry = that._oEntries[sIsoDate];
        if (!oEntry) return false;
        return oEntry.type === "vacation" || oEntry.type === "holiday" ||
               (oEntry.type === "work" && !!oEntry.duration);
      };

      // Returns actual worked minutes for a given date
      var getActualMinutes = function (sIsoDate) {
        var oEntry = that._oEntries[sIsoDate];
        if (!oEntry) return 0;
        if (oEntry.type === "vacation" || oEntry.type === "holiday") {
          var oRaw = that._oTestDataMap && that._oTestDataMap[sIsoDate];
          return oRaw && oRaw.actual_hours != null
            ? Math.round(oRaw.actual_hours * 60)
            : that._getTargetMinutesForDate(sIsoDate);
        }
        return oEntry.duration ? that._timeToMinutes(oEntry.duration) : 0;
      };

      // Returns target working minutes for a given date
      var getTargetMinutes = function (sIsoDate) {
        var oRaw = that._oTestDataMap && that._oTestDataMap[sIsoDate];
        return oRaw && oRaw.target_hours != null
          ? Math.round(oRaw.target_hours * 60)
          : that._getTargetMinutesForDate(sIsoDate);
      };

      // Sends a single webhook POST for one day
      var sendWebhookForDay = function (sIsoDate, iCumulativeMinutes) {
        var oEntry   = that._oEntries[sIsoDate];
        var iWeekday = that._parseIso(sIsoDate).getDay();
        jQuery.ajax({
          url:         sWebhookUrl,
          method:      "POST",
          contentType: "application/json",
          data: JSON.stringify({
            user:         that._sUserId || "",
            date:         sIsoDate,
            weekday:      iWeekday === 0 ? 6 : iWeekday - 1,
            start_hour:   (oEntry.type === "work" && oEntry.start) ? that._timeToDecimal(oEntry.start) : null,
            end_hour:     (oEntry.type === "work" && oEntry.end)   ? that._timeToDecimal(oEntry.end)   : null,
            actual_hours: getActualMinutes(sIsoDate) / 60,
            target_hours: getTargetMinutes(sIsoDate) / 60,
            weekly_hours: Math.round(iCumulativeMinutes / 60 * 100) / 100
          }),
          error: function () { MessageToast.show("Webhook-Fehler für " + sIsoDate); }
        });
      };

      if (!isDayComplete(sSavedIso)) return;

      // Vacation / holiday entries do not trigger a webhook chain
      var oSavedEntry = this._oEntries[sSavedIso];
      if (oSavedEntry && (oSavedEntry.type === "vacation" || oSavedEntry.type === "holiday")) return;

      var oSavedDate      = this._parseIso(sSavedIso);
      var iSavedWeekday   = oSavedDate.getDay();

      // All earlier weekdays in the same week must also be complete
      for (var i = 1; i < iSavedWeekday; i++) {
        var oPrevDay = new Date(oSavedDate.getFullYear(), oSavedDate.getMonth(), oSavedDate.getDate() - i);
        if (!isDayComplete(this._isoDate(oPrevDay))) return;
      }

      // Accumulate minutes from Monday up to and including the saved day
      var iCumulativeMinutes = 0;
      for (var j = iSavedWeekday - 1; j >= 1; j--) {
        var oEarlierDay = new Date(oSavedDate.getFullYear(), oSavedDate.getMonth(), oSavedDate.getDate() - j);
        iCumulativeMinutes += getActualMinutes(this._isoDate(oEarlierDay));
      }
      iCumulativeMinutes += getActualMinutes(sSavedIso);
      sendWebhookForDay(sSavedIso, iCumulativeMinutes);

      // Also send subsequent weekdays if they are already complete
      for (var k = 1; iSavedWeekday + k <= 5; k++) {
        var oNextDay    = new Date(oSavedDate.getFullYear(), oSavedDate.getMonth(), oSavedDate.getDate() + k);
        var sNextIso    = this._isoDate(oNextDay);
        if (!isDayComplete(sNextIso)) break;
        iCumulativeMinutes += getActualMinutes(sNextIso);
        sendWebhookForDay(sNextIso, iCumulativeMinutes);
      }
    },

    _timeToDecimal: function (sTime) {
      if (!sTime || !this._isValidTime(sTime)) return null;
      var aParts = sTime.split(":");
      return +aParts[0] + Math.round(+aParts[1] / 60 * 100) / 100;
    },

    onClearDay: function () {
      var oModel   = this.getView().getModel();
      var sIsoDate = oModel.getProperty("/selectedDay");
      if (!sIsoDate) return;

      var oExistingEntry = this._oEntries[sIsoDate];
      if (!oExistingEntry || oExistingEntry.type === "holiday" || oExistingEntry.type === "vacation") return;

      delete this._oEntries[sIsoDate];
      oModel.setData(Object.assign(oModel.getData(), {
        selectedStart: "", selectedEnd: "", selectedDuration: "", selectedBreak: "",
        selectedDaySubmitted:  "0 h",
        selectedDayUnrecorded: this._formatMinutes(this._getTargetMinutesForDate(sIsoDate)) + " h"
      }));
      this._refreshWeekSummary(sIsoDate);
      this._buildCalendarGrid();
    },

    // ── Calendar rendering ─────────────────────────────────────────────────

    _refreshCalendar: function () {
      var oModel = this.getView().getModel();
      oModel.setProperty("/monthTitle", aMonthNames[this._iMonth]);
      oModel.setProperty("/yearTitle",  String(this._iYear));
      this._buildCalendarGrid();
      var sSelectedIso = oModel.getProperty("/selectedDay");
      this._refreshWeekSummary(sSelectedIso || this._sTodayIso);
    },

    _buildCalendarGrid: function () {
      var oModel        = this.getView().getModel();
      var sSelectedIso  = oModel.getProperty("/selectedDay");
      var iYear         = this._iYear;
      var iMonth        = this._iMonth;

      var iDaysInMonth  = new Date(iYear, iMonth + 1, 0).getDate();     // Integer: number of days in month
      var iFirstWeekday = new Date(iYear, iMonth, 1).getDay();          // Integer: weekday of the 1st (0 = Sun)
      var iLeadingCells = iFirstWeekday === 0 ? 6 : iFirstWeekday - 1; // Integer: empty cells before the 1st

      var aHtmlParts = ['<div class="zeGrid">'];

      // Header row with weekday labels
      aHtmlParts.push('<div class="zeGridRow zeGridHdr">');
      aHtmlParts.push('<div class="zeWkCell zeWkHdr"></div>');
      aWeekdayHeaders.forEach(function (sLabel) {
        aHtmlParts.push('<div class="zeGridCell zeHdrCell">' + sLabel + '</div>');
      });
      aHtmlParts.push('</div>');

      var iCurrentDay = 1;
      var iRow        = 0;

      while (iCurrentDay <= iDaysInMonth) {
        var iRowStartDay    = iCurrentDay;
        var iEmptyCells     = iRow === 0 ? iLeadingCells : 0;
        var iCalendarWeek   = this._isoWeek(new Date(iYear, iMonth, iCurrentDay));

        aHtmlParts.push('<div class="zeGridRow">');
        aHtmlParts.push('<div class="zeWkCell">' + iCalendarWeek + '</div>');

        // Empty filler cells at the start of the first row
        for (var iEmpty = 0; iEmpty < iEmptyCells; iEmpty++) {
          aHtmlParts.push('<div class="zeGridCell"></div>');
        }

        // Day cells
        for (var iCol = iEmptyCells; iCol < 7 && iCurrentDay <= iDaysInMonth; iCol++) {
          var oDateObj       = new Date(iYear, iMonth, iCurrentDay);
          var iWeekday       = oDateObj.getDay();
          var bIsWeekend     = iWeekday === 0 || iWeekday === 6;
          var sIsoDate       = this._isoDate(oDateObj);
          var bIsToday       = sIsoDate === this._sTodayIso;
          var bIsSelected    = sIsoDate === sSelectedIso;
          var oEntry         = this._getEntryForDate(sIsoDate);
          var bIsFuture      = sIsoDate > this._sTodayIso;

          var sCssClasses = "zeGridCell zeDay"
            + (bIsWeekend  ? " zeWe"    : "")
            + (bIsToday    ? " zeToday" : "")
            + (bIsSelected ? " zeSel"   : "");

          var sDataAttr = bIsWeekend ? "" : ' data-iso="' + sIsoDate + '"';
          aHtmlParts.push('<div class="' + sCssClasses + '"' + sDataAttr + '>');
          aHtmlParts.push('<div class="zeDayNum">' + iCurrentDay + '</div>');

          if (!bIsWeekend) {
            var sBarColor = this._getDayBarColor(oEntry, bIsFuture);
            if (sBarColor) {
              aHtmlParts.push('<div class="zeDayBar" style="background:' + sBarColor + '"></div>');
              aHtmlParts.push('<div class="zeDayVal">' + this._getDayBarValue(oEntry, sIsoDate) + '</div>');
            }
          }
          aHtmlParts.push('</div>');
          iCurrentDay++;
        }

        // Empty filler cells at the end of each row
        var iUsedCols = iEmptyCells + (iCurrentDay - iRowStartDay);
        for (var iFill = iUsedCols; iFill < 7; iFill++) {
          aHtmlParts.push('<div class="zeGridCell"></div>');
        }
        aHtmlParts.push('</div>');
        iRow++;
      }

      aHtmlParts.push('</div>');
      oModel.setProperty("/calGridHtml", aHtmlParts.join(""));
    },

    _getDayBarColor: function (oEntry, bIsFuture) {
      if (!oEntry && bIsFuture)                        return null;
      if (!oEntry)                                     return sColorMissing;
      if (oEntry.type === "vacation")                  return sColorVacation;
      if (oEntry.type === "holiday")                   return sColorHoliday;
      if (oEntry.type === "work" && oEntry.duration)   return sColorWork;
      if (oEntry.type === "work" && bIsFuture)         return null;
      return sColorMissing;
    },

    _getDayBarValue: function (oEntry, sIsoDate) {
      if (!oEntry) return "0";
      if (oEntry.type === "vacation" || oEntry.type === "holiday")
        return this._formatMinutes(this._getTargetMinutesForDate(sIsoDate));
      if (oEntry.type === "work" && oEntry.duration) return this._formatHours(oEntry.duration);
      return "0";
    },

    // ── Statistics ─────────────────────────────────────────────────────────

    _getTargetMinutesForDate: function (sIsoDate) {
      var oRaw = this._oTestDataMap && this._oTestDataMap[sIsoDate];
      return oRaw && oRaw.target_hours != null
        ? Math.round(oRaw.target_hours * 60)
        : (this._iDefaultTargetMinutes || 480);
    },

    _calcPeriodStats: function (aIsoDates) {
      var iActualMinutes = 0;
      var iTargetMinutes = 0;

      aIsoDates.forEach(function (sIsoDate) {
        var oEntry          = this._getEntryForDate(sIsoDate);
        var iDayTargetMins  = this._getTargetMinutesForDate(sIsoDate);
        iTargetMinutes += iDayTargetMins;
        if (!oEntry) return;
        if (oEntry.type === "work" && oEntry.duration) iActualMinutes += this._timeToMinutes(oEntry.duration);
        else if (oEntry.type === "vacation" || oEntry.type === "holiday") iActualMinutes += iDayTargetMins;
      }, this);

      var iMissingMinutes   = Math.max(0, iTargetMinutes - iActualMinutes);
      var iOvertimeMinutes  = Math.max(0, iActualMinutes - iTargetMinutes);

      var sBalanceLabel = iMissingMinutes > 0
        ? this._formatMinutes(iMissingMinutes) + " h"
        : (iOvertimeMinutes > 0 ? "+" + this._formatMinutes(iOvertimeMinutes) + " h" : "0 h");

      // CSS class for the actual-hours tile based on fulfillment ratio
      var fFulfillmentRatio  = iTargetMinutes > 0 ? iActualMinutes / iTargetMinutes : 1;
      var sActualHoursClass  = fFulfillmentRatio >= 1    ? "zeStatsTileValueGreen"
                             : fFulfillmentRatio >= 0.95 ? "zeStatsTileValueOrange"
                             : "zeStatsTileValueRed";

      return {
        actual:     this._formatMinutes(iActualMinutes) + " h",
        target:     this._formatMinutes(iTargetMinutes) + " h",
        unrecorded: sBalanceLabel,
        balance:    String(iMissingMinutes - iOvertimeMinutes),
        actClass:   sActualHoursClass
      };
    },

    _getWeekdayDatesForWeek: function (oRefDate, iCalendarWeek) {
      var aWorkdays = [];
      for (var iDelta = -6; iDelta <= 6; iDelta++) {
        var oDate = new Date(oRefDate.getFullYear(), oRefDate.getMonth(), oRefDate.getDate() + iDelta);
        if (this._isoWeek(oDate) !== iCalendarWeek) continue;
        var iWeekday = oDate.getDay();
        if (iWeekday === 0 || iWeekday === 6) continue;
        aWorkdays.push(this._isoDate(oDate));
      }
      return aWorkdays;
    },

    _refreshWeekSummary: function (sRefIso) {
      var oModel        = this.getView().getModel();
      var oRefDate      = sRefIso ? this._parseIso(sRefIso) : new Date();
      var iCalWeek      = this._isoWeek(oRefDate);
      var oStats        = this._calcPeriodStats(this._getWeekdayDatesForWeek(oRefDate, iCalWeek));

      oModel.setProperty("/currentWeek",      String(iCalWeek));
      oModel.setProperty("/weekActual",        oStats.actual);
      oModel.setProperty("/weekTarget",        oStats.target);
      oModel.setProperty("/weekUnrecorded",    oStats.unrecorded);
      oModel.setProperty("/weekUnrecordedNum", oStats.balance);
      oModel.setProperty("/weekActualClass",   oStats.actClass);

      this._refreshMonthSummary();
    },

    _refreshMonthSummary: function () {
      var oModel       = this.getView().getModel();
      var iDaysInMonth = new Date(this._iYear, this._iMonth + 1, 0).getDate();
      var aWorkdays    = [];

      for (var i = 1; i <= iDaysInMonth; i++) {
        var oDate    = new Date(this._iYear, this._iMonth, i);
        var iWeekday = oDate.getDay();
        if (iWeekday === 0 || iWeekday === 6) continue;
        aWorkdays.push(this._isoDate(oDate));
      }

      var oStats = this._calcPeriodStats(aWorkdays);
      oModel.setProperty("/monthActual",        oStats.actual);
      oModel.setProperty("/monthTarget",        oStats.target);
      oModel.setProperty("/monthUnrecorded",    oStats.unrecorded);
      oModel.setProperty("/monthUnrecordedNum", oStats.balance);
    },

    // ── Time field auto-calculation (start / end / duration) ──────────────

    _applyTimeField: function (sFieldName, sRawInput) {
      var oModel    = this.getView().getModel();
      var sNormTime = this._normalizeTime(sRawInput);

      if (sFieldName === "start")    oModel.setProperty("/selectedStart",    sNormTime);
      if (sFieldName === "end")      oModel.setProperty("/selectedEnd",      sNormTime);
      if (sFieldName === "duration") oModel.setProperty("/selectedDuration", sNormTime);

      var sStart    = oModel.getProperty("/selectedStart")    || "";
      var sEnd      = oModel.getProperty("/selectedEnd")      || "";
      var sDuration = oModel.getProperty("/selectedDuration") || "";
      var bStartOk  = this._isValidTime(sStart);
      var bEndOk    = this._isValidTime(sEnd);
      var bDurOk    = this._isValidTime(sDuration);

      if (sFieldName === "start" || sFieldName === "end") {
        if (bStartOk && bEndOk) {
          // Derive duration from start and end
          var iDiff = this._timeToMinutes(sEnd) - this._timeToMinutes(sStart);
          if (iDiff >= 0) oModel.setProperty("/selectedDuration", this._minutesToTime(iDiff));
        } else if (sFieldName === "start" && bStartOk && bDurOk) {
          // Derive end from start + duration
          oModel.setProperty("/selectedEnd", this._minutesToTime(this._timeToMinutes(sStart) + this._timeToMinutes(sDuration)));
        } else if (sFieldName === "end" && bEndOk && bDurOk) {
          // Derive start from end - duration
          var iStart = this._timeToMinutes(sEnd) - this._timeToMinutes(sDuration);
          if (iStart >= 0) oModel.setProperty("/selectedStart", this._minutesToTime(iStart));
        }
      } else {
        // "duration" field changed
        if (bStartOk && bDurOk) {
          oModel.setProperty("/selectedEnd", this._minutesToTime(this._timeToMinutes(sStart) + this._timeToMinutes(sDuration)));
        } else if (bEndOk && bDurOk) {
          var iDerivedStart = this._timeToMinutes(sEnd) - this._timeToMinutes(sDuration);
          if (iDerivedStart >= 0) oModel.setProperty("/selectedStart", this._minutesToTime(iDerivedStart));
        }
      }
    },

    // ── Theme switcher ─────────────────────────────────────────────────────

    onThemePress: function (oEvent) {
      if (!this._oThemeSheet) {
        var aThemeOptions = [
          { text: "Morning Horizon (Hell)",   theme: "sap_horizon"      },
          { text: "Evening Horizon (Dunkel)", theme: "sap_horizon_dark" },
          { text: "High Contrast Schwarz",    theme: "sap_horizon_hcb"  },
          { text: "High Contrast Weiß",       theme: "sap_horizon_hcw"  }
        ];
        this._oThemeSheet = new ActionSheet({
          title: "Design wählen",
          buttons: aThemeOptions.map(function (oOption) {
            return new Button({
              text:  oOption.text,
              press: function () { sap.ui.getCore().applyTheme(oOption.theme); }
            });
          })
        });
        this.getView().addDependent(this._oThemeSheet);
      }
      this._oThemeSheet.openBy(oEvent.getSource());
    },

    // ── Helpers ────────────────────────────────────────────────────────────

    // Returns the German display label for a day entry's type
    _getDayTypeLabel: function (oEntry) {
      return oEntry ? (oDayTypeLabels[oEntry.type] || "") : "";
    },

    // Formats "HH:mm" to a decimal hours string, e.g. "7:30" → "7.5"
    _formatHours: function (sTime) {
      if (!this._isValidTime(sTime)) return "0";
      var fHours   = this._timeToMinutes(sTime) / 60;
      var fRounded = Math.round(fHours * 10) / 10;
      return fRounded % 1 === 0 ? String(Math.round(fRounded)) : String(fRounded);
    },

    // Formats a minutes total to "H:MM" or "H" when there are no remainder minutes, e.g. 90 → "1:30"
    _formatMinutes: function (iMinutes) {
      var iHours      = Math.floor(iMinutes / 60);
      var iRemainMins = iMinutes % 60;
      return iRemainMins === 0 ? String(iHours) : iHours + ":" + String(iRemainMins).padStart(2, "0");
    },

    // Normalizes free-form time input to "HH:mm"; accepts "H:MM" and "HHMM"
    _normalizeTime: function (sInput) {
      if (!sInput) return "";
      sInput = sInput.trim();
      if (/^\d{1,3}:\d{2}$/.test(sInput)) {
        var aColonParts = sInput.split(":");
        var iH = +aColonParts[0], iM = +aColonParts[1];
        if (iH >= 0 && iH <= 48 && iM >= 0 && iM < 60)
          return String(iH).padStart(2, "0") + ":" + String(iM).padStart(2, "0");
      }
      if (/^\d{3,4}$/.test(sInput)) {
        var iMinDigits = +sInput.slice(-2);
        var iHrDigits  = +sInput.slice(0, -2);
        if (iHrDigits >= 0 && iHrDigits <= 48 && iMinDigits >= 0 && iMinDigits < 60)
          return String(iHrDigits).padStart(2, "0") + ":" + String(iMinDigits).padStart(2, "0");
      }
      return "";
    },

    // Returns true if the string matches a valid "H:MM" time format
    _isValidTime: function (sTime) {
      return !!sTime && /^\d{1,3}:\d{2}$/.test(sTime);
    },

    // Converts "HH:mm" to total minutes, e.g. "1:30" → 90
    _timeToMinutes: function (sTime) {
      var aParts = sTime.split(":");
      return +aParts[0] * 60 + +aParts[1];
    },

    // Converts total minutes to "HH:mm", e.g. 90 → "01:30"
    _minutesToTime: function (iMinutes) {
      return String(Math.floor(iMinutes / 60)).padStart(2, "0") + ":" + String(iMinutes % 60).padStart(2, "0");
    },

    // Converts decimal hours to "HH:mm", e.g. 8.5 → "08:30"
    _decimalToTime: function (fDecimalHours) {
      var iHours   = Math.floor(fDecimalHours);
      var iMinutes = Math.round((fDecimalHours - iHours) * 60);
      if (iMinutes === 60) { iHours++; iMinutes = 0; }
      return String(iHours).padStart(2, "0") + ":" + String(iMinutes).padStart(2, "0");
    },

    // Formats a Date object to an ISO date string "YYYY-MM-DD"
    _isoDate: function (oDate) {
      return oDate.getFullYear() + "-"
        + String(oDate.getMonth() + 1).padStart(2, "0") + "-"
        + String(oDate.getDate()).padStart(2, "0");
    },

    // Parses an ISO date string "YYYY-MM-DD" into a Date object
    _parseIso: function (sIsoDate) {
      var aParts = sIsoDate.split("-");
      return new Date(+aParts[0], +aParts[1] - 1, +aParts[2]);
    },

    // Calculates the ISO calendar week number for a given Date object
    _isoWeek: function (oDate) {
      var oUtc     = new Date(Date.UTC(oDate.getFullYear(), oDate.getMonth(), oDate.getDate()));
      var iDayOfWk = oUtc.getUTCDay() || 7;
      oUtc.setUTCDate(oUtc.getUTCDate() + 4 - iDayOfWk);
      var oYearStart = new Date(Date.UTC(oUtc.getUTCFullYear(), 0, 1));
      return Math.ceil(((oUtc - oYearStart) / 86400000 + 1) / 7);
    }
  });
});
