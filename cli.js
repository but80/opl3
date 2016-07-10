#!/usr/bin/env node

var fs = require('fs');
var chalk = require('chalk');
var ProgressBar = require('progress');
var yargs = require('yargs');
var Duration = require('duration');
var mkdirp = require('mkdirp');
var path = require('path');
var async = require('async');
var glob = require('glob');
var numeral = require('numeral');

try{ var lame = require('lame'); }catch(err){}
try{ var ogg = require('ogg'); }catch(err){}
try{ var vorbis = require('./utils/vorbis-encoder'); }catch(err){}
try{ var Speaker = require('speaker'); }catch(err){}

var opl3 = require('./index');

var OPL3 = opl3.OPL3;
var Player = opl3.Player;
var LAA = opl3.format.LAA;
var MUS = opl3.format.MUS;
var DRO = opl3.format.DRO;
var IMF = opl3.format.IMF;
var RAW = opl3.format.RAW;
var WAV = opl3.WAV;
var package = require('./package.json');

var argv = yargs.usage(chalk.cyan('\nOPL3 emulator v' + package.version) + '\n\u001b[97mUsage:\u001b[39m\u001b[49m opl3 <input file> [OPTIONS]')
	.example('opl3 D_E1M1.mus');

if (typeof lame != 'undefined') argv = argv.describe('mp3', 'Export to MP3');
argv = argv.describe('wav', 'Export to WAV');
	
if (typeof ogg != 'undefined' && typeof vorbis != 'undefined') argv = argv.describe('ogg', 'Export to OGG');

argv = argv.describe('mid', 'Export to MIDI')
	.describe('laa', 'Use LAA format')
	.describe('mus', 'Use MUS format')
	.describe('dro', 'Use DRO format')
	.describe('imf', 'Use IMF format')
	.describe('raw', 'Use RAW format')
	.describe('genmidi', 'Use external GENMIDI lump (only MUS format)')
	.describe('normalize', 'PCM audio normalization (default on, turn off with -n0)');

if (typeof Speaker != 'undefined') argv = argv.describe('play', 'Play after processing');
	
argv = argv.describe('output', 'Output directory')
	.describe('help', 'You read that just now')
	.alias('h', 'help')
	.alias('i', 'genmidi')
	.alias('n', 'normalize');

if (typeof Speaker != 'undefined') argv = argv.alias('p', 'play');

argv = argv.alias('o', 'output')
	.epilog(chalk.cyan('Copyright (c) 2016 IDDQD@doom.js'))
	.updateStrings({
		'Options:': '\u001b[97mOptions:\u001b[39m\u001b[49m',
		'Examples:': '\u001b[97mExamples:\u001b[39m\u001b[49m'
	})
	.wrap(yargs.terminalWidth() - 1)
	.argv;

if (argv.help) yargs.showHelp();
else{
	var start = Date.now();
	if (process.argv.length < 3){
		yargs.showHelp();
		console.log(chalk.red('Input file required!'));
		process.exit(1);
	}
	
	console.log();
	console.log(chalk.cyan('OPL3 emulator v' + package.version));
	
	if (typeof argv.normalize == 'undefined') argv.normalize = 1;
	
	if (!(argv.wav || argv.mp3 || argv.ogg || argv.mid || argv.play)){
		argv.wav = true;
		argv.mp3 = true;
		argv.ogg = true;
		argv.mid = true;
	}

	if (typeof lame == 'undefined') argv.mp3 = false;
	if (typeof ogg == 'undefined' || typeof vorbis == 'undefined') argv.ogg = false;
	if (typeof Speaker == 'undefined') argv.play = false;
	
	var Midi = null;
	if (argv.mid) Midi = require('jsmidgen'); 
	
	glob(argv._[0], function(err, files){
		if (files.length < 1){
			console.log(chalk.red('Input file not found!'));
			process.exit(1);
		}
		
		process.on('SIGINT', function(){
			files.forEach(function(filename){
				if (fs.existsSync(path.join(argv.output || path.dirname(filename), path.basename(filename + '.tmp')))) fs.unlinkSync(path.join(argv.output || path.dirname(filename), path.basename(filename + '.tmp')));
				if (fs.existsSync(path.join(argv.output || path.dirname(filename), path.basename(filename + '.tmp32')))) fs.unlinkSync(path.join(argv.output || path.dirname(filename), path.basename(filename + '.tmp32')));
			});
			process.exit(1);
		});

		var genmidi = null;
		if (argv.genmidi && fs.existsSync(argv.genmidi)){
			console.log('Using GENMIDI lump', chalk.yellow(path.resolve(argv.genmidi)));
			genmidi = fs.readFileSync(argv.genmidi);
		}
		
		async.series(files.map(function(filename){
			var outputDir = argv.output || path.dirname(filename);
			mkdirp.sync(outputDir);
			filename = path.resolve(filename);
			
			return function(next){
				if (!fs.existsSync(filename)){
					console.log(chalk.red('Input file "' + filename + '" not found!'));
					process.exit(1);
				}
				
				var midiFormat;
				if (argv.laa || filename.split('.').pop().toLowerCase() == 'laa') midiFormat = LAA;
				else if (argv.mus || filename.split('.').pop().toLowerCase() == 'mus') midiFormat = MUS;
				else if (argv.dro || filename.split('.').pop().toLowerCase() == 'dro') midiFormat = DRO;
				else if (argv.imf || filename.split('.').pop().toLowerCase() == 'imf') midiFormat = IMF;
				else if (argv.raw || filename.split('.').pop().toLowerCase() == 'raw') midiFormat = RAW;
				else{
					console.log(chalk.red('Unknown file format!'));
					process.exit(1);
				}
				
				var pcmBuffer = null;
				var midiBuffer = null;
				var len = 0;
				var tasks = [];
				tasks.push(function(callback){
					fs.readFile(filename, function(err, buffer){
						var bar = new ProgressBar('Processing ' + chalk.yellow(filename) + ' [:bar] :percent :etas', {
							width: 20,
							total: buffer.length
						});

						var player = new Player(midiFormat, {
							Midi: Midi,
							onlyMidi: argv.mid && !(argv.wav || argv.mp3 || argv.ogg || argv.play),
							normalization: typeof argv.normalize == 'undefined' || argv.normalize,
							instruments: genmidi
						});
						var converter = new opl3.ConvertTo32Bit();
						var tmpWriter = fs.createWriteStream(path.join(outputDir, path.basename(filename + '.tmp')));
						var tmp32Writer = fs.createWriteStream(path.join(outputDir, path.basename(filename + '.tmp32')));
						
						if (argv.normalize){
							var normbar;
							player.normalizer.pipe(tmpWriter);

							if (argv.ogg){
								player.normalizer.pipe(converter);
								converter.pipe(tmp32Writer);
							}
						}else{
							player.pipe(tmpWriter);

							if (argv.ogg){
								player.pipe(converter);
								converter.pipe(tmp32Writer);
							}
						}

						player.load(buffer, function(err, result){
							if (result){
								pcmBuffer = result;
								len = result.byteLength;
							}
							callback();
						});
						player.on('error', callback);
						player.on('progress', function(perc){
							bar.update(perc / 100);
						});
						player.on('midi', function(midi){
							midiBuffer = new Buffer(midi);
						});
						player.on('normalization', function(perc){
							if (!normbar){
								normbar = new ProgressBar('Normalizing ' + chalk.yellow(filename) + ' [:bar] :percent :etas', {
									width: 20,
									total: 100
								});
							}

							normbar.update(perc / 100);
						});
						player.on('gain', function(scale){
							console.log('Normalization gain ' + chalk.green('x' + numeral(scale).format('0.00')));
						});
					});
				});

				if (argv.mid){
					tasks.push(function(callback){
						if (midiBuffer){
							var midiFilename = typeof argv.mid != 'string' ? path.join(outputDir, path.basename(filename.slice(0, filename.lastIndexOf('.')) + '.mid')) : argv.mid;
							mkdirp.sync(path.dirname(midiFilename));
							midiFilename = path.resolve(midiFilename);
					
							fs.writeFile(midiFilename, midiBuffer, 'binary', function(err){
								if (err) return callback(err);
								console.log('MIDI exported to ' + chalk.yellow(midiFilename));
								callback();
							});
						}else callback();
					});
				}
				
				if (argv.wav){
					tasks.push(function(callback){
						var wavFilename = typeof argv.wav != 'string' ? path.join(outputDir, path.basename(filename.slice(0, filename.lastIndexOf('.')) + '.wav')) : argv.wav;
						mkdirp.sync(path.dirname(wavFilename));
						wavFilename = path.resolve(wavFilename);
						
						fs.writeFile(wavFilename, new Buffer(WAV(pcmBuffer, { sampleRate: 49700, bitDepth: 16 })), function(err){
							console.log('WAV exported to ' + chalk.yellow(wavFilename));
							callback();
						});
					});
				}
				
				if (argv.mp3){
					tasks.push(function(callback){
						var bar = new ProgressBar('Encoding ' + chalk.yellow(filename) + ' to MP3/Lame [:bar] :percent :etas', {
							width: 20,
							total: 100
						});
						
						var encoder = new lame.Encoder({
							// input
							channels: 2,        // 2 channels (left and right)
							bitDepth: 16,       // 16-bit samples
							sampleRate: 49700,  // 49,700 Hz sample rate
						});
						
						var mp3Filename = typeof argv.mp3 != 'string' ? path.join(outputDir, path.basename(filename.slice(0, filename.lastIndexOf('.')) + '.mp3')) : argv.mp3;
						mkdirp.sync(path.dirname(mp3Filename));
						mp3Filename = path.resolve(mp3Filename);
						
						var writer = fs.createWriteStream(mp3Filename);
						var reader = fs.createReadStream(path.join(outputDir, path.basename(filename + '.tmp')));
						
						reader.pipe(encoder);
						encoder.pipe(writer);
						
						var pos = 0;
						reader.on('data', function(chunk){
							pos += chunk.length;
							bar.update(pos / len);
						});
						reader.on('end', function(){
							encoder.end();
							callback();
						});
						reader.on('error', function(err){
							console.log(chalk.red('Failed to export ' + mp3Filename));
							callback(err);
						});
					});
				}
				
				if (argv.ogg){
					tasks.push(function(callback){
						var bar = new ProgressBar('Encoding ' + chalk.yellow(filename) + ' to OGG/Vorbis [:bar] :percent :etas', {
							width: 20,
							total: 100
						});
						
						var oe = new ogg.Encoder();
						var ve = new vorbis.Encoder({
							sampleRate: 49700
						});
						
						var oggFilename = typeof argv.ogg != 'string' ? path.join(outputDir, path.basename(filename.slice(0, filename.lastIndexOf('.')) + '.ogg')) : argv.ogg;
						mkdirp.sync(path.dirname(oggFilename));
						
						var writer = fs.createWriteStream(oggFilename);
						var reader = fs.createReadStream(path.join(outputDir, path.basename(filename + '.tmp32')));
						
						reader.pipe(ve);
						ve.pipe(oe.stream());
						oe.pipe(writer);
						
						var pos = 0;
						reader.on('data', function(chunk){
							pos += chunk.length;
							bar.update(pos / (len * 2));
						});
						reader.on('end', function(){
							callback();
						});
						reader.on('error', function(err){
							console.log(chalk.red('Failed to export ' + oggFilename));
							callback(err);
						});
					});
				}
				
				if (argv.play){
					tasks.push(function(callback){
						var bar = new ProgressBar(chalk.magenta('Playing audio ') + chalk.yellow(filename) + ' [:bar] :percent :etas', {
							width: 20,
							total: 100
						});
					
						var speaker = new Speaker({
							channels: 2,          // 2 channels
							bitDepth: 16,         // 16-bit samples
							sampleRate: 49700     // 49,700 Hz sample rate
						});
						
						var reader = fs.createReadStream(path.join(outputDir, path.basename(filename + '.tmp')));
						reader.pipe(speaker);
						
						var pos = 0;
						reader.on('data', function(chunk){
							pos += chunk.length;
							bar.update(pos / len);
						});
						reader.on('end', function(){
							speaker.end();
							callback();
						});
						reader.on('error', function(err){
							console.log(chalk.red('Failed to play ' + filename));
							callback(err);
						});
					});
				}

				async.series(tasks, function(err){
					if (fs.existsSync(path.join(outputDir, path.basename(filename + '.tmp')))) fs.unlinkSync(path.join(outputDir, path.basename(filename + '.tmp')));
					if (fs.existsSync(path.join(outputDir, path.basename(filename + '.tmp32')))) fs.unlinkSync(path.join(outputDir, path.basename(filename + '.tmp32')));
					next(err);
				});
			};
		}), function(){
			console.log('Finished in ' + chalk.green(new Duration(new Date(0), new Date(Date.now() - start)).toString(1)));
		});
	});
}