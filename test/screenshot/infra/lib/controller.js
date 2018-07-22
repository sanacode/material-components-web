/*
 * Copyright 2018 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const CbtApi = require('./cbt-api');
const Cli = require('./cli');
const CliColor = require('./logger').colors;
const CloudStorage = require('./cloud-storage');
const Duration = require('./duration');
const GitRepo = require('./git-repo');
const GoldenIo = require('./golden-io');
const Logger = require('./logger');
const ReportBuilder = require('./report-builder');
const ReportWriter = require('./report-writer');
const SeleniumApi = require('./selenium-api');

class Controller {
  constructor() {
    /**
     * @type {!CbtApi}
     * @private
     */
    this.cbtApi_ = new CbtApi();

    /**
     * @type {!Cli}
     * @private
     */
    this.cli_ = new Cli();

    /**
     * @type {!CloudStorage}
     * @private
     */
    this.cloudStorage_ = new CloudStorage();

    /**
     * @type {!GitRepo}
     * @private
     */
    this.gitRepo_ = new GitRepo();

    /**
     * @type {!GoldenIo}
     * @private
     */
    this.goldenIo_ = new GoldenIo();

    /**
     * @type {!Logger}
     * @private
     */
    this.logger_ = new Logger(__filename);

    /**
     * @type {!ReportBuilder}
     * @private
     */
    this.reportBuilder_ = new ReportBuilder();

    /**
     * @type {!ReportWriter}
     * @private
     */
    this.reportWriter_ = new ReportWriter();

    /**
     * @type {!SeleniumApi}
     * @private
     */
    this.seleniumApi_ = new SeleniumApi();
  }

  /**
   * @return {!Promise<!mdc.proto.ReportData>}
   */
  async initForApproval() {
    const runReportJsonUrl = this.cli_.runReportJsonUrl;
    return this.reportBuilder_.initForApproval({runReportJsonUrl});
  }

  /**
   * @param {!mdc.proto.DiffBase} goldenDiffBase
   * @return {!Promise<!mdc.proto.ReportData>}
   */
  async initForCapture(goldenDiffBase) {
    const isOnline = this.cli_.isOnline();
    if (isOnline) {
      await this.cbtApi_.killStalledSeleniumTests();
    }
    return this.reportBuilder_.initForCapture(goldenDiffBase);
  }

  /**
   * @return {!Promise<!mdc.proto.ReportData>}
   */
  async initForDemo() {
    return this.reportBuilder_.initForDemo();
  }

  /**
   * @param {!mdc.proto.ReportData} reportData
   * @return {!Promise<!mdc.proto.ReportData>}
   */
  async uploadAllAssets(reportData) {
    this.logger_.foldStart('screenshot.upload_assets', 'Controller#uploadAllAssets()');
    await this.cloudStorage_.uploadAllAssets(reportData);
    this.logger_.foldEnd('screenshot.upload_assets');
    return reportData;
  }

  /**
   * @param {!mdc.proto.ReportData} reportData
   * @return {!Promise<!mdc.proto.ReportData>}
   */
  async captureAllPages(reportData) {
    this.logger_.foldStart('screenshot.capture_images', 'Controller#captureAllPages()');

    await this.seleniumApi_.captureAllPages(reportData);

    const meta = reportData.meta;
    meta.end_time_iso_utc = new Date().toISOString();
    meta.duration_ms = Duration.elapsed(meta.start_time_iso_utc, meta.end_time_iso_utc).toMillis();

    this.logger_.foldEnd('screenshot.capture_images');

    return reportData;
  }

  /**
   * @param {!mdc.proto.ReportData} reportData
   */
  populateMaps(reportData) {
    this.reportBuilder_.populateMaps(reportData.user_agents, reportData.screenshots);
  }

  /**
   * @param {!mdc.proto.ReportData} reportData
   * @return {!Promise<!mdc.proto.ReportData>}
   */
  async uploadAllImages(reportData) {
    this.logger_.foldStart('screenshot.upload_images', 'Controller#uploadAllImages()');
    await this.cloudStorage_.uploadAllScreenshots(reportData);
    await this.cloudStorage_.uploadAllDiffs(reportData);
    this.logger_.foldEnd('screenshot.upload_images');
    return reportData;
  }

  /**
   * @param {!mdc.proto.ReportData} reportData
   * @return {!Promise<!mdc.proto.ReportData>}
   */
  async generateReportPage(reportData) {
    this.logger_.foldStart('screenshot.generate_report', 'Controller#generateReportPage()');

    await this.reportWriter_.generateReportPage(reportData);
    await this.cloudStorage_.uploadDiffReport(reportData);

    this.logComparisonResults_(reportData);

    this.logger_.foldEnd('screenshot.generate_report');
    this.logger_.log('');

    // TODO(acdvorak): Store this directly in the proto so we don't have to recalculate it all over the place
    const numChanges =
      reportData.screenshots.changed_screenshot_list.length +
      reportData.screenshots.added_screenshot_list.length +
      reportData.screenshots.removed_screenshot_list.length;

    this.logger_.log('\n');
    if (numChanges > 0) {
      const boldRed = CliColor.bold.red;
      this.logger_.error(boldRed(`${numChanges} screenshot${numChanges === 1 ? '' : 's'} changed!\n`));
      this.logger_.log('Diff report:', boldRed(reportData.meta.report_html_file.public_url));
    } else {
      const boldGreen = CliColor.bold.green;
      this.logger_.log(boldGreen('0 screenshots changed!\n'));
      this.logger_.log('Diff report:', boldGreen(reportData.meta.report_html_file.public_url));
    }

    return reportData;
  }

  /**
   * @param {!mdc.proto.ReportData} reportData
   * @return {!Promise<!mdc.proto.ReportData>}
   */
  async approveChanges(reportData) {
    /** @type {!GoldenFile} */
    const newGoldenFile = await this.reportBuilder_.approveChanges(reportData);
    await this.goldenIo_.writeToLocalFile(newGoldenFile);
    return reportData;
  }

  /**
   * @param {!mdc.proto.ReportData} reportData
   * @private
   */
  logComparisonResults_(reportData) {
    console.log('');
    this.logComparisonResultSet_('Skipped', reportData.screenshots.skipped_screenshot_list);
    this.logComparisonResultSet_('Unchanged', reportData.screenshots.unchanged_screenshot_list);
    this.logComparisonResultSet_('Removed', reportData.screenshots.removed_screenshot_list);
    this.logComparisonResultSet_('Added', reportData.screenshots.added_screenshot_list);
    this.logComparisonResultSet_('Changed', reportData.screenshots.changed_screenshot_list);
  }

  /**
   * @param {string} title
   * @param {!Array<!mdc.proto.Screenshot>} screenshots
   * @private
   */
  logComparisonResultSet_(title, screenshots) {
    console.log(`${title} ${screenshots.length} screenshot${screenshots.length === 1 ? '' : 's'}:`);
    for (const screenshot of screenshots) {
      console.log(`  - ${screenshot.html_file_path} > ${screenshot.user_agent.alias}`);
    }
    console.log('');
  }
}

module.exports = Controller;
