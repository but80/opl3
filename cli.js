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

var lame = require('lame');
var ogg = require('ogg');
var vorbis = require('./utils/vorbis-encoder');
var Speaker = require('speaker');

var OPL3 = require('./opl3');
var LAA = require('./format/laa');
var MUS = require('./format/mus');
var DRO = require('./format/dro');
var IMF = require('./format/imf');
var RAW = require('./format/raw');
var WAV = require('./wav.js').WAV;
var package = require('./package.json');

var argv = yargs.usage(chalk.cyan('\nOPL3 emulator v' + package.version) + '\n\u001b[97mUsage:\u001b[39m\u001b[49m opl3 <input file> [OPTIONS]')
	.example('opl3 ./laa/dott_logo.laa --mp3 dott_logo.mp3 --wav dott_logo.wav --ogg dott_logo.ogg')
	.describe('mp3', 'Export to MP3')
	.describe('wav', 'Export to WAV')
	.describe('ogg', 'Export to OGG')
	.describe('mid', 'Export to MIDI')
	.describe('laa', 'Use LAA format')
	.describe('mus', 'Use MUS format')
	.describe('dro', 'Use DRO format')
	.describe('imf', 'Use IMF format')
	.describe('raw', 'Use RAW format')
	.describe('normalize', 'PCM audio normalization (default on, turn off with -n0)')
	.describe('play', 'Play after processing')
	.describe('output', 'Output directory')
	.describe('help', 'You read that just now')
	.alias('h', 'help')
	.alias('n', 'normalize')
	.alias('p', 'play')
	.alias('o', 'output')
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
		
		async.series(files.map(function(filename){
			var outputDir = argv.output || path.dirname(filename);
			mkdirp.sync(outputDir);
			
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
				
				var WritableStreamBuffer = require('stream-buffers').WritableStreamBuffer;
				var bufferWriter = new WritableStreamBuffer({
					initialSize: (1024 * 1024),
					incrementAmount: (512 * 1024)
				});
				var pcmBuffer = null;
				var len = 0;
				var tasks = [];
				tasks.push(function(callback){
					fs.readFile(filename, function(err, buffer){
						var bar = new ProgressBar('Processing ' + chalk.yellow(filename) + ' [:bar] :percent :etas', {
							width: 20,
							total: buffer.length
						});
						
						var player = new midiFormat(new OPL3(), null, Midi, argv.mid && !(argv.wav || argv.mp3 || argv.ogg || argv.play));
						player.load(new Uint8Array(buffer));
						
						var perc = 0;
						var dlen = 0;
						var fn = function(){
							var t = Date.now();
							while (player.update()){
								var d = player.refresh();
								var n = 4 * ((49700 * d) | 0);

								perc = player.position / buffer.length;
								bar.update(perc);

								len += n;
								dlen += d;

								var b16 = new Int16Array(n / 2);
								for (var i = 0, j = 0; i < n; i += 4, j += 2){
									b16.set(player.opl.read(), j);
								}
								
								bufferWriter.write(new Buffer(b16.buffer));
								
								if (Date.now() - t > 100) return setImmediate(fn);
							}
							
							if (perc < 1) bar.update(1);
						
							bufferWriter.end();
							pcmBuffer = bufferWriter.getContents();
							var dv = new DataView(pcmBuffer.buffer);
							
							if (argv.normalize){
								var normbar = new ProgressBar('Normalizing ' + chalk.yellow(filename) + ' [:bar] :percent :etas', {
									width: 20,
									total: 100
								});
								
								var peak = 0;
								var targetPeak = 32768;
								for (var i = 0; i < pcmBuffer.length; i += 2){
									var p = Math.abs(dv.getInt16(i, true));
									if (p > peak) peak = p;
									if (i % 1024 == 0) normbar.update(i / (pcmBuffer.length * 2));
								}
								var scale = targetPeak / peak;
								for (var i = 0; i < pcmBuffer.length; i += 2){
									dv.setInt16(i, Math.round(dv.getInt16(i, true) * scale), true);
									if (i % 1024 == 0) normbar.update((pcmBuffer.length + i) / (pcmBuffer.length * 2));
								}
								
								normbar.update(1);
								console.log('Normalization gain ' + chalk.green('x' + numeral(scale).format('0.00')));
							}
							
							var pcm32Buffer = new Float32Array(pcmBuffer.length / 2);
							for (var i = 0, offset = 0; offset < pcmBuffer.length; i++, offset += 2){
								pcm32Buffer[i] = dv.getInt16(offset, true) / 32768;
							}
							
							async.series([
								function(next){ fs.writeFile(path.join(outputDir, path.basename(filename + '.tmp')), pcmBuffer, next); },
								function(next){ fs.writeFile(path.join(outputDir, path.basename(filename + '.tmp32')), new Buffer(pcm32Buffer.buffer), next); },
								function(callback){
									if (argv.mid && player.midiBuffer){
										var midiFilename = typeof argv.mid != 'string' ? path.join(outputDir, path.basename(filename.slice(0, filename.lastIndexOf('.')) + '.mid')) : argv.mid;
										mkdirp.sync(path.dirname(midiFilename));
								
										fs.writeFile(midiFilename, player.midiBuffer, 'binary', function(err){
											console.log('MIDI exported to ' + chalk.yellow(midiFilename));
											callback(err);
										});
									}else callback();
								}
							], callback);							
						};
						
						fn();
					});
				});
				
				if (argv.wav){
					tasks.push(function(callback){
						var wavFilename = typeof argv.wav != 'string' ? path.join(outputDir, path.basename(filename.slice(0, filename.lastIndexOf('.')) + '.wav')) : argv.wav;
						mkdirp.sync(path.dirname(wavFilename));
						
						fs.writeFile(wavFilename, new Buffer(WAV(pcmBuffer, 49700)), function(err){
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

							// output
							bitRate: 128,
							outSampleRate: 22050,
							mode: lame.STEREO // STEREO (default), JOINTSTEREO, DUALCHANNEL or MONO
						});
						
						var mp3Filename = typeof argv.mp3 != 'string' ? path.join(outputDir, path.basename(filename.slice(0, filename.lastIndexOf('.')) + '.mp3')) : argv.mp3;
						mkdirp.sync(path.dirname(mp3Filename));
						
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