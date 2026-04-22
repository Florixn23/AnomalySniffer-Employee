sap.ui.define([
  "sap/m/MessageToast"
], function (MessageToast) {
  "use strict";

  return {

    // Replays webhooks for every user in the raw usersData array.
    //
    // oConfig shape:
    //   webhookUrl  {string}
    //   usersData   {Array}  raw user objects from testdata.json
    replayAllUsers: function (oConfig) {
      var that = this;
      (oConfig.usersData || []).forEach(function (oUser) {
        var oProcessed = that._processUserData(oUser);
        that.replayAll({
          webhookUrl:           oConfig.webhookUrl,
          userId:               oUser.user_id,
          entries:              oProcessed.entries,
          testDataMap:          oProcessed.testDataMap,
          defaultTargetMinutes: oProcessed.defaultTargetMinutes
        });
      });
    },

    // Converts a raw user object (from testdata.json) into the same internal
    // format that _applyTestData produces in the controller.
    _processUserData: function (oUserData) {
      var aRaw     = oUserData.entries || [];
      var oEntries = {};
      var oTestDataMap = {};
      var iDefaultTargetMinutes = 480;
      var that = this;

      for (var i = 0; i < aRaw.length; i++) {
        if (aRaw[i].day_type === "work" && aRaw[i].target_hours != null) {
          iDefaultTargetMinutes = Math.round(aRaw[i].target_hours * 60);
          break;
        }
      }

      aRaw.forEach(function (oRaw) {
        oTestDataMap[oRaw.date] = oRaw;
        var oEntry = { type: oRaw.day_type };
        if (oRaw.day_type === "work") {
          oEntry.start    = oRaw.start_hour   != null ? that._decimalToTime(oRaw.start_hour)   : "";
          oEntry.end      = oRaw.end_hour     != null ? that._decimalToTime(oRaw.end_hour)     : "";
          oEntry.duration = oRaw.actual_hours != null ? that._decimalToTime(oRaw.actual_hours) : "";
          oEntry.break    = "";
        }
        oEntries[oRaw.date] = oEntry;
      });

      return { entries: oEntries, testDataMap: oTestDataMap, defaultTargetMinutes: iDefaultTargetMinutes };
    },

    // Iterates all entries of one user chronologically and fires one
    // webhook POST for every complete work day whose entire week (Mon → that day)
    // is also complete.  Vacation / holiday days are skipped (no webhook).
    //
    // oConfig shape:
    //   webhookUrl            {string}
    //   userId                {string}
    //   entries               {object}  keyed by ISO date "YYYY-MM-DD"
    //   testDataMap           {object}  raw testdata.json entries, keyed by ISO date
    //   defaultTargetMinutes  {number}  fallback when target_hours is absent
    replayAll: function (oConfig) {
      var aDates = Object.keys(oConfig.entries).sort();
      var that   = this;
      aDates.forEach(function (sIsoDate) {
        that._maybeReplayDay(oConfig, sIsoDate);
      });
    },

    _maybeReplayDay: function (oConfig, sIsoDate) {
      var oEntry = oConfig.entries[sIsoDate];
      if (!oEntry) return;

      // Vacation / holiday: no webhook (mirrors _sendPendingWebhooks)
      if (oEntry.type === "vacation" || oEntry.type === "holiday") return;

      // Work day without a recorded duration: incomplete, skip
      if (oEntry.type !== "work" || !oEntry.duration) return;

      var oDate    = this._parseIso(sIsoDate);
      var iWeekday = oDate.getDay(); // 0=Sun, 1=Mon … 5=Fri, 6=Sat
      if (iWeekday === 0 || iWeekday === 6) return;

      // All earlier weekdays in the same week must be complete
      for (var i = 1; i < iWeekday; i++) {
        var oPrev    = new Date(oDate.getFullYear(), oDate.getMonth(), oDate.getDate() - i);
        var sPrevIso = this._isoDate(oPrev);
        if (!this._isDayComplete(oConfig.entries, sPrevIso)) return;
      }

      // Accumulate actual minutes from Monday up to and including this day
      var iCumulative = 0;
      for (var j = iWeekday - 1; j >= 1; j--) {
        var oEarlier = new Date(oDate.getFullYear(), oDate.getMonth(), oDate.getDate() - j);
        iCumulative += this._getActualMinutes(oConfig, this._isoDate(oEarlier));
      }
      iCumulative += this._getActualMinutes(oConfig, sIsoDate);
      this._sendWebhook(oConfig, sIsoDate, iCumulative);

      // Cascade: send remaining weekdays of the week without checking completeness
      for (var k = 1; iWeekday + k <= 5; k++) {
        var oNext    = new Date(oDate.getFullYear(), oDate.getMonth(), oDate.getDate() + k);
        var sNextIso = this._isoDate(oNext);
        iCumulative += this._getActualMinutes(oConfig, sNextIso);
        this._sendWebhook(oConfig, sNextIso, iCumulative);
      }
    },

    _isDayComplete: function (oEntries, sIsoDate) {
      var oEntry = oEntries[sIsoDate];
      if (!oEntry) return false;
      return oEntry.type === "vacation" || oEntry.type === "holiday" ||
             (oEntry.type === "work" && !!oEntry.duration);
    },

    _getActualMinutes: function (oConfig, sIsoDate) {
      var oEntry = oConfig.entries[sIsoDate];
      if (!oEntry) return 0;
      if (oEntry.type === "vacation" || oEntry.type === "holiday") {
        var oRaw = oConfig.testDataMap && oConfig.testDataMap[sIsoDate];
        return oRaw && oRaw.actual_hours != null
          ? Math.round(oRaw.actual_hours * 60)
          : this._getTargetMinutes(oConfig, sIsoDate);
      }
      return oEntry.duration ? this._timeToMinutes(oEntry.duration) : 0;
    },

    _getTargetMinutes: function (oConfig, sIsoDate) {
      var oRaw = oConfig.testDataMap && oConfig.testDataMap[sIsoDate];
      return oRaw && oRaw.target_hours != null
        ? Math.round(oRaw.target_hours * 60)
        : (oConfig.defaultTargetMinutes || 480);
    },

    _sendWebhook: function (oConfig, sIsoDate, iCumulativeMinutes) {
      var oEntry   = oConfig.entries[sIsoDate];
      if (!oEntry) return;
      var iWeekday = this._parseIso(sIsoDate).getDay();
      jQuery.ajax({
        url:         oConfig.webhookUrl,
        method:      "POST",
        contentType: "application/json",
        data: JSON.stringify({
          user:         oConfig.userId || "",
          date:         sIsoDate,
          weekday:      iWeekday === 0 ? 6 : iWeekday - 1,
          start_hour:   (oEntry.type === "work" && oEntry.start) ? this._timeToDecimal(oEntry.start) : null,
          end_hour:     (oEntry.type === "work" && oEntry.end)   ? this._timeToDecimal(oEntry.end)   : null,
          actual_hours: this._getActualMinutes(oConfig, sIsoDate) / 60,
          target_hours: this._getTargetMinutes(oConfig, sIsoDate) / 60,
          weekly_hours: Math.round(iCumulativeMinutes / 60 * 100) / 100
        }),
        error: function () { MessageToast.show("Webhook-Fehler für " + sIsoDate); }
      });
    },

    // ── Helpers (self-contained copies, no controller dependency) ────────────

    _parseIso: function (sIsoDate) {
      var p = sIsoDate.split("-");
      return new Date(+p[0], +p[1] - 1, +p[2]);
    },

    _isoDate: function (oDate) {
      return oDate.getFullYear() + "-"
        + String(oDate.getMonth() + 1).padStart(2, "0") + "-"
        + String(oDate.getDate()).padStart(2, "0");
    },

    _timeToMinutes: function (sTime) {
      var p = sTime.split(":");
      return +p[0] * 60 + +p[1];
    },

    _timeToDecimal: function (sTime) {
      if (!sTime || !/^\d{1,3}:\d{2}$/.test(sTime)) return null;
      var p = sTime.split(":");
      return +p[0] + Math.round(+p[1] / 60 * 100) / 100;
    },

    _decimalToTime: function (fDecimalHours) {
      var iHours   = Math.floor(fDecimalHours);
      var iMinutes = Math.round((fDecimalHours - iHours) * 60);
      if (iMinutes === 60) { iHours++; iMinutes = 0; }
      return String(iHours).padStart(2, "0") + ":" + String(iMinutes).padStart(2, "0");
    }
  };
});
